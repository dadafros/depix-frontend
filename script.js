// DePix — Main entry point (ES module)

// Imports the "depix" Trusted Types policy module. The CSP currently
// declares the policy name (`trusted-types depix`) without
// `require-trusted-types-for 'script'`, so the wrappers are a no-op at
// runtime — they exist so a future PR can flip enforcement on without
// rewriting every call site. See `trusted-types.js` header for why
// enforcement is deferred (Cloudflare Turnstile incompatibility).
import { toTrustedHTML, toTrustedScriptURL } from "./trusted-types.js";
import { route, navigate, initRouter } from "./router.js";
import { isLoggedIn, setAuth, clearAuth, getUser, getRefreshToken } from "./auth.js";
import { apiFetch } from "./api.js";
import {
  getAddresses, addAddress, removeAddress,
  getSelectedAddress, setSelectedAddress,
  abbreviateAddress, hasAddresses
} from "./addresses.js";
import { toCents, formatBRL, formatDePix, escapeHtml, slugify } from "./utils.js";
import { validateLiquidAddress, parseLiquidUri, validatePhone, validatePixKey, validateCPF, validateCNPJ, formatPixKey, preparePixKeyForApi } from "./validation.js";
import { showToast, setMsg, goToAppropriateScreen as _goToAppropriateScreen } from "./script-helpers.js";
import { scanQRCode, isQrScannerSupported, QR_SCANNER_ERRORS } from "./qr-scanner.js";
import { captureReferralCode, buildRegistrationBody, clearReferralCode, buildAffiliateLink, renderReferralsHTML, generateFingerprint } from "./affiliates.js";
import { renderBrandedQr } from "./qr.js";
import { renderPrintableQr } from "./qr-print.js";
import { resizeImage } from "./image-resize.js";
import { loadWalletBundle } from "./wallet-bundle-loader.js";
import { getDefaultConfigClient } from "./wallet/config.js";
import { planHomeToggle } from "./wallet-home-gate.js";
import { planIntegratedWallet } from "./wallet-integrated-gate.js";

// Resolve the current user's preferred deposit address. If a wallet exists on
// this device we deposit straight into it — no more copy-paste. Otherwise we
// fall back to the legacy selected-address picker (`addresses.js`). Failing
// silently here is intentional: the caller already handles a null return by
// surfacing "selecione um endereço".
//
// The raw IDB probe (`hasWalletInIdbRaw`, hoisted — defined later in this
// file) answers "is there a wallet?" without paying the ~200kb wallet bundle
// download. Users without a wallet must never trigger `loadWalletBundle()`
// just to get their deposit address (plan Sub-fase 1: "Usuários sem wallet
// não carregam o bundle").
async function resolveWalletReceiveAddress() {
  if (!(await hasWalletFast())) return null;
  try {
    const bundle = await loadWalletBundle();
    const w = bundle.getDefaultWallet();
    if (!(await w.hasWallet())) return null;
    const addr = await w.getReceiveAddress();
    if (typeof addr !== "string" || !validateLiquidAddress(addr).valid) return null;
    return addr;
  } catch {
    return null;
  }
}

// ===== Constants =====
const MIN_VALOR_CENTS = 500;
const MAX_VALOR_CENTS = 300000;
let qrCopyPaste = "";
let deferredPrompt = null;
let pendingAddressChange = "";
let pendingAddressDelete = "";
let modoSaque = false;
let modoConvert = false;
let modoWallet = false;
let walletHomeActive = false;
let brswapConfig = null;
let valorModeIsPix = false;
let saqueDepositAddress = "";
let lastDepositQrId = "";
let lastWithdrawalId = "";
let transactionsPollingInterval = null;

// Register service worker with update detection
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(toTrustedScriptURL("./service-worker.js")).then(reg => {
    // Check for SW updates on every page load
    reg.update();
  });

  // When a new SW takes control, reload to get fresh assets
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// ===== Utility functions =====
// showToast and setMsg are imported from script-helpers.js

// generateBrandedQr and renderPixQr are now imported from qr.js (local generation, no external API)

function formatCurrencyInput(input, mode) {
  if (!input) return;
  input.addEventListener("input", () => {
    let v = input.value.replace(/\D/g, "");
    if (!v) { input.value = ""; return; }
    v = (v / 100).toFixed(2).replace(".", ",");
    const useDepix = mode === "saque" && !valorModeIsPix;
    input.value = useDepix ? v + " DePix" : "R$ " + v;
  });
}

// ===== Image upload helpers =====

/**
 * Upload an image file to R2 via presigned URL flow.
 * @param {File} file - Image file from <input type="file">
 * @param {"logo"|"product"} type
 * @param {string|null} productId - Required if type === "product"
 * @returns {Promise<string>} Public URL of uploaded image
 */
async function uploadImage(file, type, productId = null) {
  const maxSize = type === "logo" ? 144 : 360;
  const blob = await resizeImage(file, maxSize);

  const uploadBody = { type, content_type: blob.type || "image/webp" };
  if (productId) uploadBody.product_id = productId;

  const urlRes = await apiFetch("/api/upload-url", { method: "POST", body: JSON.stringify(uploadBody) });
  const urlData = await urlRes.json();
  if (!urlRes.ok) throw new Error(urlData?.response?.errorMessage || "Erro ao preparar upload.");

  const putRes = await fetch(urlData.upload_url, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "image/webp" },
    body: blob,
  });
  if (!putRes.ok) throw new Error("Falha no upload da imagem. Tente novamente.");

  const confirmBody = { type, key: urlData.key };
  if (productId) confirmBody.product_id = productId;
  const confirmRes = await apiFetch("/api/upload-confirm", { method: "POST", body: JSON.stringify(confirmBody) });
  const confirmData = await confirmRes.json();
  if (!confirmRes.ok) throw new Error(confirmData?.response?.errorMessage || "Erro ao confirmar upload.");

  return confirmData.url;
}

/**
 * Delete an image from R2 via the backend.
 * @param {"logo"|"product"} type
 * @param {string|null} productId
 */
async function deleteImageApi(type, productId = null) {
  const body = { type };
  if (productId) body.product_id = productId;
  await apiFetch("/api/upload-image", { method: "DELETE", body: JSON.stringify(body) });
}

/**
 * Initialize an image-file-row component: wire up file selection and removal.
 * @param {string} rowId - DOM id of the .image-file-row element
 * @returns {{ getFile: () => File|null, reset: () => void, setExisting: (hasImage: boolean) => void, isMarkedForRemoval: () => boolean }}
 */
function initImageFileRow(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return { getFile: () => null, reset: () => {}, setExisting: () => {}, isMarkedForRemoval: () => false };

  const fileInput = row.querySelector(".image-file-input");
  const emptyState = row.querySelector(".image-file-empty");
  const selectedState = row.querySelector(".image-file-selected");
  const existingState = row.querySelector(".image-file-existing");
  const uploadingState = row.querySelector(".image-file-uploading");
  const fileName = row.querySelector(".image-file-name");
  const removeBtn = row.querySelector(".image-file-remove");
  const removeExistingBtn = row.querySelector(".image-file-remove-existing");
  const changeBtn = row.querySelector(".image-file-change");

  let selectedFile = null;
  let markedForRemoval = false;

  function showState(state) {
    emptyState?.classList.toggle("hidden", state !== "empty");
    selectedState?.classList.toggle("hidden", state !== "selected");
    if (existingState) existingState.classList.toggle("hidden", state !== "existing");
    uploadingState?.classList.toggle("hidden", state !== "uploading");
    if (fileInput) fileInput.style.display = state === "uploading" ? "none" : "";
  }

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file && file.type.startsWith("image/")) {
        selectedFile = file;
        markedForRemoval = false;
        if (fileName) fileName.textContent = file.name;
        showState("selected");
      }
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedFile = null;
      if (fileInput) fileInput.value = "";
      showState("empty");
    });
  }

  if (removeExistingBtn) {
    removeExistingBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectedFile = null;
      markedForRemoval = true;
      if (fileInput) fileInput.value = "";
      showState("empty");
    });
  }

  if (changeBtn) {
    changeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fileInput?.click();
    });
  }

  return {
    getFile: () => selectedFile,
    reset: () => {
      selectedFile = null;
      markedForRemoval = false;
      if (fileInput) fileInput.value = "";
      showState("empty");
    },
    setExisting: (hasImage) => {
      selectedFile = null;
      markedForRemoval = false;
      if (fileInput) fileInput.value = "";
      showState(hasImage ? "existing" : "empty");
    },
    setUploading: () => showState("uploading"),
    setDone: () => showState("empty"),
    isMarkedForRemoval: () => markedForRemoval,
  };
}

// Initialize image file rows
const productCreateImageRow = initImageFileRow("product-create-image-row");
const productEditImageRow = initImageFileRow("product-edit-image-row");
const merchantCreateLogoRow = initImageFileRow("merchant-create-logo-row");

// ===== Detect installed PWA =====
function isAppInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

// ===== Blocked account =====
window.addEventListener("user-blocked", () => {
  document.getElementById("blocked-modal")?.classList.remove("hidden");
});

// ===== PWA Install =====
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
});

window.addEventListener("appinstalled", () => {
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "none";
});

document.getElementById("installBtn")?.addEventListener("click", async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    document.getElementById("installBtn").style.display = "none";
    return;
  }
  const modal = document.getElementById("installModal");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const iosSection = document.getElementById("install-ios");
  const androidSection = document.getElementById("install-android");
  if (iosSection) iosSection.style.opacity = isIOS ? "1" : "0.6";
  if (androidSection) androidSection.style.opacity = isIOS ? "0.6" : "1";
  modal?.classList.remove("hidden");
});

document.getElementById("closeModal")?.addEventListener("click", () => {
  document.getElementById("installModal")?.classList.add("hidden");
});

// Wallet guide modal — opened from the "Como cadastrar carteira externa
// com o app SideSwap" link inside the Carteira Externa modal. The guide
// lays on top of the external-wallet-modal, which stays open behind it,
// so closing the guide returns the user to the input in its previous state.
document.getElementById("external-wallet-guide-link")?.addEventListener("click", () => {
  document.getElementById("wallet-guide-modal")?.classList.remove("hidden");
});
document.getElementById("btn-wallet-guide-register")?.addEventListener("click", () => {
  document.getElementById("wallet-guide-modal")?.classList.add("hidden");
  const input = document.getElementById("new-addr-input");
  if (input) setTimeout(() => input.focus(), 50);
});

// SideSwap link — opens correct store based on device
document.getElementById("sideswap-link")?.addEventListener("click", () => {
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) || /Mac/.test(navigator.platform);
  const url = isApple
    ? "https://apps.apple.com/br/app/sideswap/id1556476417"
    : "https://play.google.com/store/apps/details?id=io.sideswap";
  window.open(url, "_blank", "noopener,noreferrer");
});

// Populate shared FAQ content from templates (single source of truth)
for (const [tplId, cls] of [
  ["tpl-faq-what-is", "faq-content-what-is"],
  ["tpl-faq-deposit", "faq-content-deposit"],
  ["tpl-faq-withdraw", "faq-content-withdraw"],
  ["tpl-faq-security", "faq-content-security"],
  ["tpl-faq-depix-uses", "faq-content-depix-uses"],
  ["tpl-faq-ecosystem", "faq-content-ecosystem"],
  ["tpl-faq-liquid-address", "faq-content-liquid-address"],
  ["tpl-faq-change-address", "faq-content-change-address"],
  ["tpl-faq-processing-time", "faq-content-processing-time"],
  ["tpl-faq-fees", "faq-content-fees"],
  ["tpl-faq-affiliates", "faq-content-affiliates"],
  ["tpl-faq-report", "faq-content-report"]
]) {
  const tpl = document.getElementById(tplId);
  if (tpl) {
    for (const target of document.querySelectorAll("." + cls)) {
      target.appendChild(tpl.content.cloneNode(true));
    }
  }
}

if (isAppInstalled()) {
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "none";
}

// =========================================
// LOGIN
// =========================================

async function handleLogin() {
  const usuario = document.getElementById("login-usuario").value.trim();
  const senha = document.getElementById("login-senha").value;

  setMsg("login-msg", "");
  document.getElementById("login-verify-action")?.classList.add("hidden");

  if (!usuario || !senha) {
    setMsg("login-msg", "Preencha seu usuário e senha para entrar");
    return;
  }

  const btn = document.getElementById("btn-login");
  btn.disabled = true;
  btn.innerText = "Entrando…";

  try {
    let fp = null;
    try { fp = await generateFingerprint(); } catch {}

    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ usuario, senha, ...(fp && { fingerprint: fp }) })
    });
    const data = await res.json();

    if (!res.ok) {
      const errorMsg = data?.response?.errorMessage || "Erro ao fazer login";
      setMsg("login-msg", errorMsg);

      // Show resend verification link if email not verified
      if (errorMsg.toLowerCase().includes("verificad")) {
        sessionStorage.setItem("depix-verify-usuario", usuario);
        document.getElementById("login-verify-action")?.classList.remove("hidden");
      }
      return;
    }

    setAuth(data.token, data.refreshToken, data.user);
    goToAppropriateScreen();
  } catch (e) {
    if (e.blocked) return; // Modal already shown via user-blocked event
    setMsg("login-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Entrar";
  }
}

document.getElementById("btn-login")?.addEventListener("click", handleLogin);

// Enter key triggers login
for (const id of ["login-usuario", "login-senha"]) {
  document.getElementById(id)?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLogin();
  });
}

// =========================================
// REGISTER
// =========================================

// ===== Turnstile CAPTCHA for registration =====
let turnstileWidgetId = null;

function renderTurnstile() {
  const container = document.getElementById("turnstile-container");
  if (!container || typeof turnstile === "undefined") return;
  if (turnstileWidgetId !== null) {
    turnstile.reset(turnstileWidgetId);
    return;
  }
  turnstileWidgetId = turnstile.render("#turnstile-container", {
    sitekey: "0x4AAAAAAC1DLVejZBg3u_ND",
    theme: "dark",
    "error-callback": () => setMsg("register-msg", "Erro no CAPTCHA. Recarregue a página.")
  });
}

document.getElementById("btn-register")?.addEventListener("click", async () => {
  const nome = document.getElementById("reg-nome").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const whatsapp = document.getElementById("reg-whatsapp").value.trim();
  const usuario = document.getElementById("reg-usuario").value.trim();
  const senha = document.getElementById("reg-senha").value;

  setMsg("register-msg", "");

  if (!nome || !email || !whatsapp || !usuario || !senha) {
    setMsg("register-msg", "Preencha todos os campos");
    return;
  }

  const phoneResult = validatePhone(whatsapp);
  if (!phoneResult.valid) {
    setMsg("register-msg", phoneResult.error);
    return;
  }

  if (senha.length < 8) {
    setMsg("register-msg", "Senha deve ter no mínimo 8 caracteres");
    return;
  }

  // Get Turnstile token
  let cfTurnstileResponse = null;
  if (typeof turnstile !== "undefined" && turnstileWidgetId !== null) {
    cfTurnstileResponse = turnstile.getResponse(turnstileWidgetId);
    if (!cfTurnstileResponse) {
      setMsg("register-msg", "Aguarde a verificação de segurança completar.");
      return;
    }
  }

  const btn = document.getElementById("btn-register");
  btn.disabled = true;
  btn.innerText = "Criando conta…";

  try {
    let fp = null;
    try { fp = await generateFingerprint(); } catch {}

    const body = buildRegistrationBody({ nome, email, whatsapp, usuario, senha }, fp);
    if (cfTurnstileResponse) body.cfTurnstileResponse = cfTurnstileResponse;

    const res = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("register-msg", data?.response?.errorMessage || "Erro ao criar conta");
      if (typeof turnstile !== "undefined" && turnstileWidgetId !== null) {
        turnstile.reset(turnstileWidgetId);
      }
      return;
    }

    clearReferralCode();
    sessionStorage.setItem("depix-verify-usuario", usuario);
    const infoEl = document.getElementById("verify-info");
    if (infoEl) {
      infoEl.innerText = `Enviamos um código de 6 dígitos para ${email}. Verifique sua caixa de entrada e spam.`;
    }
    navigate("#verify");
  } catch (e) {
    setMsg("register-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
    if (typeof turnstile !== "undefined" && turnstileWidgetId !== null) {
      turnstile.reset(turnstileWidgetId);
    }
  } finally {
    btn.disabled = false;
    btn.innerText = "Criar conta";
  }
});

// =========================================
// VERIFY EMAIL
// =========================================

function getVerifyUsuario() {
  return sessionStorage.getItem("depix-verify-usuario") ||
    document.getElementById("verify-usuario")?.value.trim() || "";
}

function startResendCooldown(linkId, seconds) {
  const link = document.getElementById(linkId);
  if (!link) return;
  const originalText = link.innerText;
  link.style.pointerEvents = "none";
  link.style.opacity = "0.5";
  let remaining = seconds;
  const timer = setInterval(() => {
    remaining--;
    link.innerText = `Reenviar código (${remaining}s)`;
    if (remaining <= 0) {
      clearInterval(timer);
      link.innerText = originalText;
      link.style.pointerEvents = "";
      link.style.opacity = "";
    }
  }, 1000);
}

document.getElementById("btn-verify")?.addEventListener("click", async () => {
  const codigo = document.getElementById("verify-code").value.trim();
  const usuario = getVerifyUsuario();

  setMsg("verify-msg", "");

  if (!usuario) {
    setMsg("verify-msg", "Informe seu nome de usuário");
    document.getElementById("verify-usuario-group")?.classList.remove("hidden");
    return;
  }

  if (!codigo || codigo.length !== 6) {
    setMsg("verify-msg", "Digite o código de 6 dígitos");
    return;
  }

  const btn = document.getElementById("btn-verify");
  btn.disabled = true;
  btn.innerText = "Verificando…";

  try {
    const res = await apiFetch("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ usuario, codigo })
    });
    const data = await res.json();

    if (!res.ok || data?.response?.errorMessage) {
      setMsg("verify-msg", data?.response?.errorMessage || "Erro na verificação");
      return;
    }

    setMsg("verify-msg", "Email verificado! Redirecionando para login...", true);
    setTimeout(() => navigate("#login"), 1500);
  } catch (e) {
    setMsg("verify-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Verificar";
  }
});

// Resend verification code from verify screen
document.getElementById("btn-resend-verify")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const usuario = getVerifyUsuario();

  if (!usuario) {
    setMsg("verify-msg", "Informe seu nome de usuário");
    document.getElementById("verify-usuario-group")?.classList.remove("hidden");
    return;
  }

  try {
    const res = await apiFetch("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ action: "resend", usuario })
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("verify-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao reenviar código");
      return;
    }

    setMsg("verify-msg", "Código reenviado! Verifique seu email.", true);
    startResendCooldown("btn-resend-verify", 30);
  } catch (e) {
    setMsg("verify-msg", e.message || "Erro de conexão");
  }
});

// Resend verification code from login screen
document.getElementById("btn-resend-login")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const usuario = sessionStorage.getItem("depix-verify-usuario") ||
    document.getElementById("login-usuario").value.trim();

  if (!usuario) {
    setMsg("login-msg", "Informe seu usuário acima para reenviar o código");
    return;
  }

  sessionStorage.setItem("depix-verify-usuario", usuario);

  try {
    const res = await apiFetch("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ action: "resend", usuario })
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("login-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao reenviar código");
      return;
    }

    navigate("#verify");
    // setTimeout ensures the message is set AFTER the route handler clears verify-msg
    setTimeout(() => setMsg("verify-msg", "Código reenviado! Verifique seu email.", true), 0);
  } catch (e) {
    setMsg("login-msg", e.message || "Erro de conexão");
  }
});

// =========================================
// FORGOT PASSWORD
// =========================================

document.getElementById("btn-forgot")?.addEventListener("click", async () => {
  const identificador = document.getElementById("forgot-identificador").value.trim();
  setMsg("forgot-msg", "");

  if (!identificador) {
    setMsg("forgot-msg", "Informe seu usuário ou email");
    return;
  }

  const btn = document.getElementById("btn-forgot");
  btn.disabled = true;
  btn.innerText = "Enviando…";

  try {
    const res = await apiFetch("/api/auth/password-reset", {
      method: "POST",
      body: JSON.stringify({ identificador })
    });
    await res.json();

    sessionStorage.setItem("depix-reset-identificador", identificador);
    navigate("#reset-password");
    setTimeout(() => setMsg("reset-msg", "Se o usuário existir, um código foi enviado para o email cadastrado.", true), 0);
  } catch (e) {
    setMsg("forgot-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Enviar código";
  }
});

// =========================================
// RESET PASSWORD
// =========================================

document.getElementById("btn-reset-password")?.addEventListener("click", async () => {
  const codigo = document.getElementById("reset-code").value.trim();
  const novaSenha = document.getElementById("reset-nova-senha").value;
  const confirmarSenha = document.getElementById("reset-confirmar-senha").value;
  const identificador = sessionStorage.getItem("depix-reset-identificador") || "";

  setMsg("reset-msg", "");

  if (!identificador) {
    setMsg("reset-msg", "Sessão expirada. Solicite um novo código.");
    return;
  }

  if (!codigo || codigo.length !== 6) {
    setMsg("reset-msg", "Digite o código de 6 dígitos");
    return;
  }

  if (!novaSenha || novaSenha.length < 8) {
    setMsg("reset-msg", "A nova senha deve ter no mínimo 8 caracteres");
    return;
  }

  if (novaSenha !== confirmarSenha) {
    setMsg("reset-msg", "As senhas não coincidem");
    return;
  }

  const btn = document.getElementById("btn-reset-password");
  btn.disabled = true;
  btn.innerText = "Redefinindo…";

  try {
    const res = await apiFetch("/api/auth/password-reset", {
      method: "POST",
      body: JSON.stringify({ action: "reset", identificador, codigo, novaSenha })
    });
    const data = await res.json();

    if (!res.ok || data?.response?.errorMessage) {
      setMsg("reset-msg", data?.response?.errorMessage || "Erro ao redefinir senha");
      return;
    }

    sessionStorage.removeItem("depix-reset-identificador");
    navigate("#login");
    setTimeout(() => setMsg("login-msg", "Senha redefinida! Faça login com sua nova senha.", true), 0);
  } catch (e) {
    setMsg("reset-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Redefinir senha";
  }
});

document.getElementById("btn-resend-reset")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const identificador = sessionStorage.getItem("depix-reset-identificador") || "";

  if (!identificador) {
    setMsg("reset-msg", "Sessão expirada. Volte e solicite um novo código.");
    return;
  }

  try {
    const res = await apiFetch("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ action: "resend_reset", identificador })
    });
    await res.json();

    setMsg("reset-msg", "Código reenviado! Verifique seu email.", true);
    startResendCooldown("btn-resend-reset", 30);
  } catch (e) {
    setMsg("reset-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  }
});

// =========================================
// HOME — Mode switch (Depósito / Saque)
// =========================================

// ===================================================================
// Home destination selector — Sub-fase 6 plan: users with an in-app
// wallet choose between receiving/sending via the wallet (default) or
// an external address (legacy flow). Users WITHOUT a wallet see the
// legacy UX unchanged — selector hidden, chip shows external address.
// One shared choice persists across deposit and withdraw so the user's
// mental model is "where does my money live" rather than per-form.
// ===================================================================
const HOME_DESTINATION_KEY = "depix-home-destination";

function readHomeDestinationChoice() {
  try {
    return localStorage.getItem(HOME_DESTINATION_KEY) === "external" ? "external" : "wallet";
  } catch {
    return "wallet";
  }
}

function writeHomeDestinationChoice(choice) {
  try { localStorage.setItem(HOME_DESTINATION_KEY, choice); }
  catch { /* private mode */ }
}

// Resolves the effective destination at submit time.
//   { source: "wallet" | "external", addr: string | null, error?: string }
// `addr` is null when the effective choice lacks a usable address. When
// `source === "wallet"` and `addr === null`, `error` is populated and the
// caller MUST surface the failure (no silent fallback to external — that
// would deposit to a different destination than the chip implies).
async function resolveHomeDestination() {
  const hasWallet = await hasWalletFast();
  const choice = hasWallet ? readHomeDestinationChoice() : "external";
  if (choice === "wallet") {
    const walletAddr = await resolveWalletReceiveAddress();
    if (walletAddr) return { source: "wallet", addr: walletAddr };
    // Wallet declared present but the bundle / receive address could not
    // be obtained. Surface this distinctly so the handler can show the
    // wallet-error modal — falling back silently is unacceptable because
    // the chip still says "Carteira Integrada".
    return { source: "wallet", addr: null, error: "wallet-resolve-failed" };
  }
  return { source: "external", addr: getSelectedAddress() };
}

// Lists the destination options available to the user — used by merchant
// create/edit and commission payment flows. Each entry has a stable `source`
// key and a user-facing label. Address resolution is deferred to submit time
// (via `resolveDestinationAddress`) so we never load the wallet bundle just
// to render a dropdown. `external` is included only when the user has a
// selected external address, since unselected externals can't be used.
async function listDestinationOptions() {
  const out = [];
  if (await hasWalletFast()) {
    out.push({ source: "wallet", label: "Carteira Integrada" });
  }
  const externalAddr = getSelectedAddress();
  if (externalAddr) {
    out.push({
      source: "external",
      label: `Carteira Externa: ${abbreviateAddress(externalAddr)}`,
      address: externalAddr
    });
  }
  return out;
}

// Resolves a dropdown option to the actual Liquid address. Returns
// `{ addr, error? }`. `error === "wallet-resolve-failed"` mirrors
// `resolveHomeDestination` so callers can surface the same modal.
async function resolveDestinationAddress(source) {
  if (source === "wallet") {
    const addr = await resolveWalletReceiveAddress();
    if (addr) return { addr };
    return { addr: null, error: "wallet-resolve-failed" };
  }
  if (source === "external") {
    const addr = getSelectedAddress();
    if (addr) return { addr };
    return { addr: null, error: "no-external-selected" };
  }
  return { addr: null, error: "unknown-source" };
}

// Shows the wallet-error modal when the integrated wallet can't be reached
// at submit time. The optional `context.onSwitchToExternal` callback lets
// non-home callers (merchant-create, merchant-liquid-edit, payment-address)
// flip THEIR own dropdown to external instead of mutating the global home
// destination. Default (no context) keeps the home-flow behavior.
let walletErrorContext = null;

function showWalletErrorModal(context = null) {
  walletErrorContext = context;
  document.getElementById("wallet-error-modal")?.classList.remove("hidden");
}

function closeWalletErrorModal() {
  document.getElementById("wallet-error-modal")?.classList.add("hidden");
  walletErrorContext = null;
}

document.getElementById("btn-wallet-error-retry")?.addEventListener("click", () => {
  closeWalletErrorModal();
});

document.getElementById("btn-wallet-error-external")?.addEventListener("click", () => {
  const ctx = walletErrorContext;
  closeWalletErrorModal();
  if (ctx?.onSwitchToExternal) {
    ctx.onSwitchToExternal();
    return;
  }
  // Default: home-flow behavior — write the global preference + refresh chip.
  writeHomeDestinationChoice("external");
  void refreshHomeDestination();
  // If user has no external selected, the chip and the next submit attempt
  // both surface "Nenhum endereço" / "Selecione um endereço…" — same path
  // a wallet-less user would hit.
  if (!getSelectedAddress()) {
    showToast("Cadastre um endereço externo no menu para continuar.");
  } else {
    showToast("Trocado para Carteira Externa.");
  }
});

// Generic destination-dropdown helper. Used by merchant-create,
// merchant-liquid-edit, and payment-address flows. Replaces three
// near-identical populate functions and three separate outside-click
// handlers with a single implementation.
//
// Returns:
//   - populate(): re-renders options from listDestinationOptions(), shows
//     empty-state when neither wallet nor external is configured.
//   - selectOption(source): programmatically pick "wallet" | "external"
//     (used by the wallet-error modal's "switch to external" callback).
//   - getSource(): returns the currently selected source or null.
function setupDestinationDropdown({
  dropdownId,
  optionsId,
  toggleId,
  toggleTextId,
  emptyMsgId,
  submitBtnId,
}) {
  const getEls = () => ({
    dropdown: document.getElementById(dropdownId),
    options: document.getElementById(optionsId),
    toggle: document.getElementById(toggleId),
    toggleText: document.getElementById(toggleTextId),
    emptyMsg: emptyMsgId ? document.getElementById(emptyMsgId) : null,
    submitBtn: submitBtnId ? document.getElementById(submitBtnId) : null,
  });

  document.getElementById(toggleId)?.addEventListener("click", () => {
    const dropdown = document.getElementById(dropdownId);
    const opts = document.getElementById(optionsId);
    if (!dropdown || !opts) return;
    const isOpen = dropdown.classList.contains("open");
    dropdown.classList.toggle("open", !isOpen);
    opts.classList.toggle("hidden", isOpen);
  });

  document.getElementById(optionsId)?.addEventListener("click", (e) => {
    const opt = e.target.closest(".custom-dropdown-option");
    if (!opt) return;
    selectOption(opt.dataset.source);
  });

  function selectOption(sourceValue) {
    const { dropdown, options: opts, toggleText } = getEls();
    if (!dropdown || !opts) return;
    const opt = opts.querySelector(`.custom-dropdown-option[data-source="${sourceValue}"]`);
    if (!opt) return;
    if (toggleText) toggleText.textContent = opt.textContent;
    opts.querySelectorAll(".custom-dropdown-option").forEach(o => o.classList.remove("selected"));
    opt.classList.add("selected");
    dropdown.dataset.source = sourceValue;
    dropdown.classList.remove("open");
    opts.classList.add("hidden");
  }

  async function populate() {
    const { dropdown, options: opts, toggleText, emptyMsg, submitBtn } = getEls();
    if (!dropdown || !opts) return;
    const list = await listDestinationOptions();
    opts.innerHTML = toTrustedHTML("");
    if (list.length === 0) {
      dropdown.classList.add("hidden");
      emptyMsg?.classList.remove("hidden");
      if (submitBtn) submitBtn.disabled = true;
      if (toggleText) toggleText.textContent = "Selecionar carteira…";
      delete dropdown.dataset.source;
      return;
    }
    dropdown.classList.remove("hidden");
    emptyMsg?.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = false;
    opts.innerHTML = toTrustedHTML(list.map(o =>
      `<div class="custom-dropdown-option" data-source="${o.source}">${escapeHtml(o.label)}</div>`
    ).join(""));
    // Auto-select the first option so the form is submittable without an
    // extra tap. Wallet beats external when both exist (matches home
    // destination priority in resolveHomeDestination).
    const first = opts.querySelector(".custom-dropdown-option");
    if (first) {
      first.classList.add("selected");
      if (toggleText) toggleText.textContent = first.textContent;
      dropdown.dataset.source = first.dataset.source;
    }
  }

  function getSource() {
    return document.getElementById(dropdownId)?.dataset.source || null;
  }

  return { populate, selectOption, getSource };
}

// Single global outside-click handler for every `.custom-dropdown.open`.
// Replaces three separate per-dropdown handlers. Each handler used to fire
// on every document click; this single one does the same work without
// triplication.
document.addEventListener("click", (e) => {
  document.querySelectorAll(".custom-dropdown.open").forEach((dropdown) => {
    if (!dropdown.contains(e.target)) {
      dropdown.classList.remove("open");
      dropdown.querySelector(".custom-dropdown-options")?.classList.add("hidden");
    }
  });
});

const paymentAddrDropdown = setupDestinationDropdown({
  dropdownId: "payment-addr-dropdown",
  optionsId: "payment-addr-options",
  toggleId: "payment-addr-toggle",
  toggleTextId: "payment-addr-toggle-text",
  emptyMsgId: "payment-addr-empty",
  submitBtnId: "btn-payment-address-submit",
});

const merchantLiquidEditDropdown = setupDestinationDropdown({
  dropdownId: "merchant-liquid-edit-dropdown",
  optionsId: "merchant-liquid-edit-options",
  toggleId: "merchant-liquid-edit-toggle",
  toggleTextId: "merchant-liquid-edit-toggle-text",
  emptyMsgId: "merchant-liquid-edit-empty",
  submitBtnId: "btn-merchant-liquid-edit-save",
});

const merchantAddrDropdown = setupDestinationDropdown({
  dropdownId: "merchant-addr-dropdown",
  optionsId: "merchant-addr-options",
  toggleId: "merchant-addr-toggle",
  toggleTextId: "merchant-addr-toggle-text",
  emptyMsgId: "merchant-addr-empty",
  submitBtnId: "btn-create-merchant",
});

// Hash navigation closes any open destination-flow modal and clears its
// sensitive in-memory state. The router only swaps section[data-view]; it
// doesn't touch modals or module-level state, so without this listener a
// password / address can persist across views (CLAUDE.md "Red flags").
window.addEventListener("hashchange", () => {
  const liquidEdit = document.getElementById("merchant-liquid-edit-modal");
  if (liquidEdit && !liquidEdit.classList.contains("hidden")) {
    liquidEdit.classList.add("hidden");
    pendingLiquidPassword = null;
  }
  const payAddr = document.getElementById("payment-address-modal");
  if (payAddr && !payAddr.classList.contains("hidden")) {
    payAddr.classList.add("hidden");
  }
  const payConfirm = document.getElementById("payment-confirm-modal");
  if (payConfirm && !payConfirm.classList.contains("hidden")) {
    payConfirm.classList.add("hidden");
  }
  pendingPaymentAddress = null;
  closeWalletErrorModal();
});

// Flag-first check — reads the localStorage `depix-wallet-exists` cache
// set on wallet create/restore and cleared on wipe. Falls back to a raw
// IDB probe only when the flag is missing (covers legacy installs that
// predate the flag). Centralised so deposit/withdraw/modal handlers all
// see the same answer without each re-probing IDB.
async function hasWalletFast() {
  let flag = false;
  try { flag = localStorage.getItem("depix-wallet-exists") === "1"; }
  catch { /* private mode */ }
  if (flag) return true;
  return await hasWalletInIdbRaw();
}

async function refreshHomeDestination() {
  const hasWallet = await hasWalletFast();
  if (!hasWallet && readHomeDestinationChoice() === "wallet") {
    // Force external when the wallet is gone (wipe flow) so the chip and
    // submit handlers don't keep pointing at a vanished wallet.
    writeHomeDestinationChoice("external");
  }
  const choice = hasWallet ? readHomeDestinationChoice() : "external";
  const externalAddr = getSelectedAddress();
  const externalAbbrev = externalAddr ? abbreviateAddress(externalAddr) : null;

  // Header chip — identity when the effective destination is the integrated
  // wallet, abbreviated external address otherwise. The integrated-wallet
  // fingerprint is cached in localStorage under `depix-wallet-identity`
  // (populated by wallet-ui.js on create / restore / export) so we never
  // pay the bundle-load tax just to render the chip. Missing cache → show
  // the bare label; the fingerprint backfills on next wallet interaction.
  const display = document.getElementById("addr-display");
  if (display) {
    if (hasWallet && choice === "wallet") {
      let identity = "";
      try { identity = localStorage.getItem("depix-wallet-identity") || ""; }
      catch { /* private mode */ }
      display.innerText = identity
        ? `Carteira Integrada: ${identity}`
        : "Carteira Integrada";
      display.title = identity
        ? `Carteira Integrada do DePix App · identidade ${identity}`
        : "Carteira Integrada do DePix App";
      display.classList.add("addr-chip-wallet");
    } else if (externalAddr) {
      display.innerText = `Carteira Externa: ${externalAbbrev}`;
      display.title = `Carteira Externa · ${externalAddr}`;
      display.classList.remove("addr-chip-wallet");
    } else {
      display.innerText = "Nenhum endereço";
      display.title = "";
      display.classList.remove("addr-chip-wallet");
    }
  }
}

// Back-compat shim — existing call sites pass through to the new async
// refresher. Fire-and-forget is fine; the render only touches DOM.
function updateAddrDisplay() {
  void refreshHomeDestination();
}

// Wallet-ui fires this once it has cached the integrated-wallet fingerprint
// (backfill on first wallet-home mount for pre-existing wallets). We simply
// re-render the chip so "Carteira Integrada" picks up the "XXXX-XXXX" suffix
// without waiting for another refresh trigger.
window.addEventListener("wallet-identity:changed", () => {
  void refreshHomeDestination();
});

function switchMode(mode) {
  const modes = ["deposit", "withdraw", "convert", "wallet"];
  const buttons = {
    deposit: "modeDeposit",
    withdraw: "modeWithdraw",
    convert: "modeConvert",
    wallet: "modeWallet"
  };
  const screens = {
    deposit: "telaDeposito",
    withdraw: "telaSaque",
    convert: "telaConverter",
    wallet: "telaCarteira"
  };

  modes.forEach(m => {
    const btn = document.getElementById(buttons[m]);
    const screen = document.getElementById(screens[m]);
    if (m === mode) {
      btn?.classList.add("active");
      btn?.setAttribute("aria-checked", "true");
      screen?.classList.remove("hidden");
    } else {
      btn?.classList.remove("active");
      btn?.setAttribute("aria-checked", "false");
      screen?.classList.add("hidden");
    }
  });

  // Remove iframe and clean up when leaving convert mode
  if (mode !== "convert") {
    const container = document.getElementById("converterContent");
    if (container) container.innerHTML = toTrustedHTML("");
    document.getElementById("converterError")?.classList.add("hidden");
    document.getElementById("converterLoading")?.classList.add("hidden");
    if (brswapMessageHandler) {
      window.removeEventListener("message", brswapMessageHandler);
      brswapMessageHandler = null;
    }
  }

  modoSaque = mode === "withdraw";
  modoConvert = mode === "convert";
  modoWallet = mode === "wallet";

  // Remember the user's last mode so returning from a wallet sub-route
  // (receive, settings, transactions) restores the right tab.
  try {
    localStorage.setItem("depix-home-mode", mode);
  } catch { /* private mode / disabled storage */ }

  // Load BRSwap widget when entering convert mode
  if (mode === "convert") loadBrswapWidget();

  // Lazy-load the wallet bundle and kick off a sync when entering wallet mode.
  if (mode === "wallet") activateWalletHome();
  else if (walletHomeActive) deactivateWalletHome();

  // Re-render the destination selector so deposit/withdraw tiles reflect the
  // current wallet availability and external-address selection.
  if (mode === "deposit" || mode === "withdraw") {
    void refreshHomeDestination();
  }
}

async function activateWalletHome() {
  walletHomeActive = true;
  // When the kill-switch is ON and the user has a wallet, we replace the
  // whole wallet-home body with a maintenance message + CTA. Showing the
  // balances + Send/Receive actions during a backend-declared outage is
  // risky — the user might try to move money on paths that were just
  // declared unsafe. The maintenance view funnels them to a SideSwap
  // restore guide where they can move funds via their 12 words.
  const enabled = await isWalletFeatureEnabled();
  applyWalletHomeMaintenance(!enabled);
  if (!enabled) return;
  try {
    await ensureWalletBootstrapped();
    // registerWalletRoutes exposes a `mountWalletHome` handler that the
    // script calls to draw balances into #telaCarteira. We fire a custom
    // event; wallet-ui.js listens for it.
    window.dispatchEvent(new CustomEvent("wallet-home:mount"));
  } catch {
    const msg = document.getElementById("wallet-home-msg");
    if (msg) {
      msg.textContent = "Não foi possível carregar a carteira. Verifique sua conexão.";
      msg.classList.add("error");
    }
  }
}

function applyWalletHomeMaintenance(on) {
  const active = document.getElementById("wallet-home-active");
  const maint = document.getElementById("wallet-home-maintenance-view");
  active?.classList.toggle("hidden", on);
  maint?.classList.toggle("hidden", !on);
}

function deactivateWalletHome() {
  walletHomeActive = false;
  window.dispatchEvent(new CustomEvent("wallet-home:unmount"));
}

let brswapMessageHandler = null;

function loadBrswapWidget() {
  const container = document.getElementById("converterContent");
  const errorEl = document.getElementById("converterError");
  const loadingEl = document.getElementById("converterLoading");
  if (!container || !errorEl) return;

  // Clean up previous message listener
  if (brswapMessageHandler) {
    window.removeEventListener("message", brswapMessageHandler);
    brswapMessageHandler = null;
  }

  container.innerHTML = toTrustedHTML("");
  errorEl.classList.add("hidden");
  loadingEl?.classList.add("hidden");

  if (!brswapConfig || !brswapConfig.active) {
    errorEl.classList.remove("hidden");
    return;
  }

  // Show loading
  loadingEl?.classList.remove("hidden");

  let src = "https://brswap.me/widget";
  if (brswapConfig.partnerId) {
    src += "?ref=" + encodeURIComponent(brswapConfig.partnerId);
  }

  const wrapper = document.createElement("div");
  wrapper.className = "brswap-iframe-wrapper";

  const iframe = document.createElement("iframe");
  iframe.src = src;
  iframe.width = "420";
  iframe.height = "1600";
  iframe.frameBorder = "0";
  iframe.setAttribute("scrolling", "yes");
  iframe.setAttribute("allow", "clipboard-write");
  iframe.style.cssText = "border: none; width: 100%; display: block;";

  let loaded = false;

  function resizeIframeToContent() {
    if (!container.contains(iframe)) return;
    try {
      const h = iframe.contentWindow.document.documentElement.scrollHeight;
      if (h > 0) iframe.height = h;
    } catch {
      // Cross-origin: can't read height directly
    }
  }

  iframe.addEventListener("load", () => {
    loaded = true;
    loadingEl?.classList.add("hidden");
    resizeIframeToContent();
    setTimeout(resizeIframeToContent, 1000);
    setTimeout(resizeIframeToContent, 3000);
  });

  iframe.addEventListener("error", () => {
    loadingEl?.classList.add("hidden");
    container.innerHTML = toTrustedHTML("");
    errorEl.classList.remove("hidden");
  });

  // Listen for postMessage resize events from the widget
  brswapMessageHandler = (e) => {
    if (!container.contains(iframe)) return;
    if (!iframe.src.startsWith(e.origin)) return;
    const data = typeof e.data === "string" ? (() => { try { return JSON.parse(e.data); } catch { return {}; } })() : (e.data || {});
    const h = data.height || data.frameHeight || data.size?.height;
    if (h && typeof h === "number" && h > 0) iframe.height = h;
  };
  window.addEventListener("message", brswapMessageHandler);

  // Timeout fallback — if iframe doesn't load in 10s, show error
  setTimeout(() => {
    if (!loaded && container.contains(iframe)) {
      loadingEl?.classList.add("hidden");
      container.innerHTML = toTrustedHTML("");
      errorEl.classList.remove("hidden");
    }
  }, 10000);

  wrapper.appendChild(iframe);
  container.appendChild(wrapper);
}

async function fetchBrswapConfig() {
  try {
    const res = await apiFetch("/api/status?type=features");
    const data = await res.json();
    brswapConfig = data?.brswap || null;
  } catch {
    brswapConfig = null;
  }

  const convertBtn = document.getElementById("modeConvert");
  if (brswapConfig?.active) {
    convertBtn.classList.remove("hidden");
  } else {
    convertBtn.classList.add("hidden");
    // If user was on convert screen, switch back to deposit
    if (modoConvert) switchMode("deposit");
  }
}

document.getElementById("modeDeposit")?.addEventListener("click", () => {
  if (!modoSaque && !modoConvert && !modoWallet) return;
  switchMode("deposit");
});

document.getElementById("modeWithdraw")?.addEventListener("click", () => {
  if (modoSaque) return;
  switchMode("withdraw");
});

document.getElementById("modeConvert")?.addEventListener("click", () => {
  if (modoConvert) return;
  if (!localStorage.getItem("depix-brswap-warned")) {
    document.getElementById("brswap-modal")?.classList.remove("hidden");
    return;
  }
  switchMode("convert");
});

document.getElementById("modeWallet")?.addEventListener("click", () => {
  if (modoWallet) return;
  switchMode("wallet");
});

document.getElementById("brswap-modal-ok")?.addEventListener("click", () => {
  localStorage.setItem("depix-brswap-warned", "1");
  document.getElementById("brswap-modal")?.classList.add("hidden");
  switchMode("convert");
});

document.getElementById("valorModeTrack")?.addEventListener("click", () => {
  valorModeIsPix = !valorModeIsPix;
  const track = document.getElementById("valorModeTrack");
  const text = document.getElementById("valorModeText");
  const valorInput = document.getElementById("valorSaque");

  if (valorModeIsPix) {
    track.classList.add("active");
    text.innerText = "Valor que você recebe";
    if (valorInput) valorInput.placeholder = "R$ 0,00";
  } else {
    track.classList.remove("active");
    text.innerText = "Valor que você envia";
    if (valorInput) valorInput.placeholder = "0,00 DePix";
  }

  // Re-format current value with correct prefix/suffix
  if (valorInput && valorInput.value) {
    let v = valorInput.value.replace(/\D/g, "");
    if (v) {
      v = (v / 100).toFixed(2).replace(".", ",");
      valorInput.value = valorModeIsPix ? "R$ " + v : v + " DePix";
    }
  }
});

// =========================================
// HOME — Depósito (QR Code generation)
// =========================================

formatCurrencyInput(document.getElementById("valor"), "deposito");
formatCurrencyInput(document.getElementById("valorSaque"), "saque");

document.getElementById("btnGerar")?.addEventListener("click", async () => {
  setMsg("mensagem", "");

  const valorInput = document.getElementById("valor");
  // Destination is either the user's in-app wallet (default when one
  // exists) or an external address the user has explicitly selected via
  // the home tile's "Usar endereço externo" toggle. For users without a
  // wallet this always resolves to the external path — zero regression.
  const { source, addr, error } = await resolveHomeDestination();

  if (!valorInput.value) {
    setMsg("mensagem", "Informe o valor");
    return;
  }

  if (error === "wallet-resolve-failed") {
    showWalletErrorModal();
    return;
  }

  if (!addr) {
    setMsg("mensagem", "Selecione um endereço no menu antes de continuar");
    return;
  }

  // Defense in depth: revalidate the address right before submit. Catches
  // cases where localStorage was tampered with, the wallet returned an
  // invalid address, or a previous version stored something malformed.
  const addrValidation = validateLiquidAddress(addr);
  if (!addrValidation.valid) {
    setMsg("mensagem", addrValidation.error);
    return;
  }

  const valorCents = toCents(valorInput.value);

  if (valorCents < MIN_VALOR_CENTS) {
    setMsg("mensagem", "O valor mínimo é R$ 5,00");
    return;
  }
  if (valorCents > MAX_VALOR_CENTS) {
    showLimitModal();
    return;
  }

  const btn = document.getElementById("btnGerar");
  btn.disabled = true;
  btn.innerText = "Gerando…";
  document.getElementById("loading").classList.remove("hidden");

  try {
    const res = await apiFetch("/api/deposit", {
      method: "POST",
      body: JSON.stringify({
        amountInCents: valorCents,
        depixAddress: addr
      })
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    qrCopyPaste = data.response.qrCopyPaste;
    lastDepositQrId = data.response.id;

    // Swap the hint BEFORE reveal so the user never sees the stale copy
    // during the brief window before renderBrandedQr paints the QR image.
    const hintEl = document.getElementById("qrHint");
    if (hintEl) {
      const walletLabel = source === "wallet" ? "integrada" : "externa";
      hintEl.innerHTML = toTrustedHTML(`Escaneie com o app do seu banco ou copie o código Pix para pagar.<br>O valor irá cair na sua carteira ${walletLabel}.`);
    }

    document.getElementById("formDeposito").classList.add("hidden");
    document.getElementById("resultado").classList.remove("hidden");

    // Generate QR code locally from PIX copy-paste data
    renderBrandedQr(qrCopyPaste, document.getElementById("qrImage"), {
      loadingEl: document.getElementById("qrLoading"),
      errorEl: document.getElementById("qrImageError")
    });

  } catch (e) {
    setMsg("mensagem", e.message || "Não foi possível gerar o código. Tente novamente.");
  } finally {
    document.getElementById("loading").classList.add("hidden");
    btn.disabled = false;
    btn.innerText = "Gerar QR code de pagamento";
  }
});

document.getElementById("btnCopy")?.addEventListener("click", async () => {
  const copyBtn = document.getElementById("btnCopy");
  try {
    await navigator.clipboard.writeText(qrCopyPaste);
    showToast("Código copiado. Cole no app do seu banco.");
    copyBtn.classList.add("copied");
    copyBtn.querySelector(".address-copy-icon")?.classList.add("hidden");
    copyBtn.querySelector(".address-copy-check")?.classList.remove("hidden");
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.querySelector(".address-copy-icon")?.classList.remove("hidden");
      copyBtn.querySelector(".address-copy-check")?.classList.add("hidden");
    }, 2000);
  } catch {
    showToast("Não foi possível copiar. Copie manualmente.");
  }
});

document.getElementById("btnReset")?.addEventListener("click", () => {
  document.getElementById("resultado").classList.add("hidden");
  document.getElementById("formDeposito").classList.remove("hidden");
  document.getElementById("valor").value = "";
  setMsg("mensagem", "");
});

// =========================================
// HOME — Saque
// =========================================

// Restore saved PIX key
const savedPixKey = localStorage.getItem("depix-pixkey");
if (savedPixKey) {
  const pixKeyEl = document.getElementById("pixKey");
  if (pixKeyEl) pixKeyEl.value = savedPixKey;
}

// PIX key input: real-time formatting + disambiguation
let pixKeyDisambigChoice = null;
let pixKeyLastRaw = "";

function stripPixFormatting(val) {
  return val.replace(/[.\-/\s()+]/g, "");
}

document.getElementById("pixKey")?.addEventListener("input", () => {
  const input = document.getElementById("pixKey");
  const disambig = document.getElementById("pixKeyDisambig");
  const btnSacar = document.getElementById("btnSacar");
  if (!input || !disambig) return;

  // Get raw digits/chars (strip all formatting)
  const raw = stripPixFormatting(input.value);

  // Reset disambiguation if raw value changed
  if (raw !== pixKeyLastRaw) {
    pixKeyDisambigChoice = null;
    disambig.querySelectorAll(".pix-disambig-pill").forEach((p) => p.classList.remove("active"));
  }
  pixKeyLastRaw = raw;

  const trimmed = input.value.trim();
  const digits = raw.replace(/\D/g, "");
  const isAllDigits = digits.length === raw.length;
  const hasAt = trimmed.includes("@");
  const startsPlus = trimmed.startsWith("+");
  const isUuid = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(trimmed);

  // Determine if we should format in real-time
  let detectedType = null;

  if (startsPlus) {
    // Phone with + prefix
    if (digits.startsWith("55") && digits.length >= 12) detectedType = "phone";
  } else if (hasAt || isUuid) {
    // No formatting for email/UUID
    detectedType = null;
  } else if (isAllDigits) {
    if (digits.length === 10 && digits[2] !== "9") detectedType = "phone";
    else if (digits.length === 12 && digits.startsWith("55")) detectedType = "phone";
    else if (digits.length === 13 && digits.startsWith("55")) detectedType = "phone";
    else if (digits.length === 14) detectedType = "cnpj";
  } else if (/^[0-9a-zA-Z]+$/.test(raw) && raw.length === 14) {
    detectedType = "cnpj";
  }

  // Apply real-time formatting (preserve cursor position)
  // For phone: format locally without +55 prefix to avoid corrupting the raw value
  if (detectedType && !hasAt && !isUuid) {
    const cursorPos = input.selectionStart;
    let formatted;
    if (detectedType === "phone") {
      // Extract local digits (strip leading 55 if user typed country code)
      const d = raw.replace(/\D/g, "");
      const has55 = d.startsWith("55") && d.length > 11;
      const local = has55 ? d.slice(2) : d;
      // Keep the prefix the user typed to avoid changing raw value on re-edit
      const prefix = startsPlus ? "+55 " : has55 ? "55 " : "";
      if (local.length === 10) {
        formatted = `${prefix}${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
      } else if (local.length === 11) {
        formatted = `${prefix}${local.slice(0, 2)} ${local.slice(2, 7)}-${local.slice(7)}`;
      } else {
        formatted = input.value;
      }
    } else {
      formatted = formatPixKey(raw, detectedType);
    }
    if (formatted !== input.value) {
      input.value = formatted;
      // Estimate new cursor position
      const diff = formatted.length - (trimmed.length || 0);
      input.setSelectionRange(cursorPos + diff, cursorPos + diff);
    }
  }

  // Show/hide disambiguation pills (only for exactly 11 digits)
  if (isAllDigits && digits.length === 11 && !startsPlus) {
    const cpfValid = validateCPF(digits).valid;
    const phoneValid = digits[2] === "9";
    if (cpfValid && phoneValid) {
      disambig.classList.remove("hidden");
      // Disable submit until user picks
      if (!pixKeyDisambigChoice && btnSacar) {
        btnSacar.disabled = true;
      }
    } else {
      disambig.classList.add("hidden");
      if (btnSacar) btnSacar.disabled = false;

      // Auto-format if type is certain
      if (cpfValid && !phoneValid) {
        const formatted = formatPixKey(digits, "cpf");
        if (formatted !== input.value) input.value = formatted;
      } else if (!cpfValid && phoneValid) {
        // Format phone locally without +55 prefix
        const formatted = `${digits.slice(0, 2)} ${digits.slice(2, 7)}-${digits.slice(7)}`;
        if (formatted !== input.value) input.value = formatted;
      }
    }
  } else {
    disambig.classList.add("hidden");
    if (btnSacar) btnSacar.disabled = false;
  }
});

// Disambiguation pill click handlers
document.getElementById("pixKeyDisambig")?.addEventListener("click", (e) => {
  const pill = e.target.closest(".pix-disambig-pill");
  if (!pill) return;

  const disambig = document.getElementById("pixKeyDisambig");
  const input = document.getElementById("pixKey");
  const btnSacar = document.getElementById("btnSacar");

  disambig.querySelectorAll(".pix-disambig-pill").forEach((p) => p.classList.remove("active"));
  pill.classList.add("active");
  pixKeyDisambigChoice = pill.dataset.type;

  if (btnSacar) btnSacar.disabled = false;

  // Format according to choice
  if (input) {
    const raw = stripPixFormatting(input.value);
    let formatted;
    if (pixKeyDisambigChoice === "phone") {
      // Format phone locally without +55 prefix
      const d = raw.replace(/\D/g, "");
      if (d.length === 11) {
        formatted = `${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`;
      } else {
        formatted = input.value;
      }
    } else {
      formatted = formatPixKey(raw, pixKeyDisambigChoice);
    }
    if (formatted !== input.value) input.value = formatted;
  }
});

document.getElementById("btnSacar")?.addEventListener("click", async () => {
  setMsg("mensagemSaque", "");

  const valorSaqueInput = document.getElementById("valorSaque");
  const pixKeyInput = document.getElementById("pixKey");
  // The withdraw endpoint does not take a Liquid address — the user is the
  // sender and the destination address is generated by Eulen and returned in
  // the response. We only need to know whether to hand off to #wallet-send
  // (post /api/withdraw, prefill the integrated wallet, archive liquid_txid)
  // or render the legacy depositAddress/QR card for manual broadcast.
  const hasWallet = (await hasWalletFast()) && readHomeDestinationChoice() === "wallet";

  if (!valorSaqueInput.value || !pixKeyInput.value.trim()) {
    setMsg("mensagemSaque", "Preencha todos os campos");
    return;
  }

  // Validate PIX key
  const pixResult = validatePixKey(pixKeyInput.value.trim(), pixKeyDisambigChoice);

  if (pixResult.type === "ambiguous") {
    setMsg("mensagemSaque", "Selecione se a chave é CPF ou Telefone.");
    return;
  }

  if (!pixResult.valid) {
    setMsg("mensagemSaque", pixResult.error);
    return;
  }

  const valorCents = toCents(valorSaqueInput.value);

  if (valorCents < MIN_VALOR_CENTS) {
    setMsg("mensagemSaque", "O valor mínimo é R$ 5,00");
    return;
  }
  if (valorCents > MAX_VALOR_CENTS) {
    showLimitModal();
    return;
  }

  // Determine the raw PIX key to send to API
  const pixKeyForApi = preparePixKeyForApi(pixKeyInput.value.trim(), pixKeyDisambigChoice);

  // Save PIX key for convenience
  localStorage.setItem("depix-pixkey", pixKeyInput.value.trim());

  const btn = document.getElementById("btnSacar");
  btn.disabled = true;
  btn.innerText = "Processando…";
  document.getElementById("loadingSaque").classList.remove("hidden");

  try {
    const body = {
      pixKey: pixKeyForApi
    };

    if (valorModeIsPix) {
      body.payoutAmountInCents = valorCents;
    } else {
      body.depositAmountInCents = valorCents;
    }

    const res = await apiFetch("/api/withdraw", {
      method: "POST",
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    const r = data.response;
    lastWithdrawalId = r.id;

    // Validate the Liquid deposit address that came from Eulen before we
    // either render its QR or hand it off to the integrated wallet send
    // flow. Defends against a corrupted backend response — the user would
    // otherwise broadcast L-BTC to a malformed address and lose funds.
    const depositAddrValidation = validateLiquidAddress(r.depositAddress);
    if (!depositAddrValidation.valid) {
      throw new Error(`Endereço Liquid inválido recebido. Tente novamente ou contate o suporte.`);
    }

    if (hasWallet) {
      // Bootstrap the wallet UI BEFORE dispatching the prefill event.
      // `registerWalletRoutes()` — invoked inside `ensureWalletBootstrapped()`
      // — is what registers the `wallet-send:prefill` listener. Dispatching
      // before that runs fires the event into the void (CustomEvent delivery
      // is synchronous) and the user lands on an empty #wallet-send form with
      // no way to recover the live Eulen deposit address. If the bundle fails
      // to load we fall through to the legacy saque UI so the user can still
      // broadcast manually from any Liquid wallet.
      let walletReady = false;
      try {
        await ensureWalletBootstrapped();
        walletReady = true;
      } catch (err) {
        console.error("wallet bundle load failed on withdraw handoff", err);
        showToast("Não foi possível carregar a carteira. Use o endereço abaixo para enviar manualmente.");
      }
      if (walletReady) {
        window.dispatchEvent(new CustomEvent("wallet-send:prefill", {
          detail: {
            assetKey: "DEPIX",
            amountBrl: r.depositAmountInCents / 100,
            dest: r.depositAddress,
            withdrawalId: r.id
          }
        }));
        try { localStorage.setItem("depix-home-mode", "wallet"); } catch { /* ignore */ }
        document.getElementById("formSaque").classList.add("hidden");
        navigate("#wallet-send");
        return;
      }
      // else: fall through to the legacy depositAddress/QR card below.
    }

    document.getElementById("saqueDepositAmount").innerText = formatDePix(r.depositAmountInCents);
    document.getElementById("saquePayoutAmount").innerText = formatBRL(r.payoutAmountInCents);
    saqueDepositAddress = r.depositAddress;
    document.getElementById("saqueAddress").innerText = abbreviateAddress(r.depositAddress);

    // Generate branded QR code for the Liquid address
    const saqueQr = document.getElementById("saqueQr");
    renderBrandedQr(r.depositAddress, saqueQr, {
      loadingEl: document.getElementById("saqueQrLoading"),
      errorEl: document.getElementById("saqueQrError")
    });

    // Show warning about exact amount
    const warnIcon = '<svg class="saque-warning-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    const infoEl = document.getElementById("saqueWarningInfo");
    if (infoEl) {
      infoEl.innerHTML = toTrustedHTML(`${warnIcon} Sacando ${formatBRL(r.payoutAmountInCents)} para a chave Pix <b>${escapeHtml(pixResult.formatted)}</b>. Confira com cuidado antes de enviar.`);
      infoEl.classList.remove("hidden");
    }
    const amountEl = document.getElementById("saqueWarningAmount");
    if (amountEl) {
      amountEl.innerHTML = toTrustedHTML(`${warnIcon} Envie EXATAMENTE ${formatDePix(r.depositAmountInCents)}. Qualquer outro valor ou moeda causará perda permanente.`);
      amountEl.classList.remove("hidden");
    }

    document.getElementById("formSaque").classList.add("hidden");
    document.getElementById("resultadoSaque").classList.remove("hidden");

  } catch (e) {
    setMsg("mensagemSaque", e.message || "Não foi possível processar. Tente novamente.");
  } finally {
    document.getElementById("loadingSaque").classList.add("hidden");
    btn.disabled = false;
    btn.innerText = "Solicitar saque";
  }
});

async function copyAddress(btn) {
  try {
    await navigator.clipboard.writeText(saqueDepositAddress);
    showToast("Endereço copiado.");
    btn.classList.add("copied");
    btn.querySelector(".address-copy-icon")?.classList.add("hidden");
    btn.querySelector(".address-copy-check")?.classList.remove("hidden");
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.querySelector(".address-copy-icon")?.classList.remove("hidden");
      btn.querySelector(".address-copy-check")?.classList.add("hidden");
    }, 2000);
  } catch {
    showToast("Não foi possível copiar. Copie manualmente.");
  }
}

document.getElementById("btnCopyAddress")?.addEventListener("click", function () { copyAddress(this); });

document.getElementById("btnNovoSaque")?.addEventListener("click", () => {
  document.getElementById("resultadoSaque").classList.add("hidden");
  document.getElementById("formSaque").classList.remove("hidden");
  document.getElementById("saqueQr").classList.add("hidden");
  document.getElementById("valorSaque").value = "";
  setMsg("mensagemSaque", "");
});

// =========================================
// MENU
// =========================================

function openMenu() {
  document.getElementById("menu-overlay").classList.remove("hidden");
}

function closeMenu() {
  document.getElementById("menu-overlay").classList.add("hidden");
}

document.getElementById("menu-btn")?.addEventListener("click", openMenu);
document.getElementById("menu-btn-empty")?.addEventListener("click", openMenu);
document.getElementById("menu-close")?.addEventListener("click", closeMenu);

document.getElementById("menu-overlay")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("menu-overlay")) {
    closeMenu();
  }
});

// Reset all user-specific app state (prevents data leaking between accounts)
function resetAppState() {
  stopTransactionsPolling();
  stopSalesPolling();

  // General state
  qrCopyPaste = "";
  pendingAddressChange = "";
  pendingAddressDelete = "";
  modoSaque = false;
  modoConvert = false;
  brswapConfig = null;
  valorModeIsPix = false;
  saqueDepositAddress = "";
  lastDepositQrId = "";
  lastWithdrawalId = "";

  // Transactions state
  allTransactions = [];
  filteredTransactions = [];
  displayedCount = 0;

  // Merchant state
  merchantData = null;
  salesDisplayedCount = 0;
  filteredSales = [];
  allSalesCheckouts = [];
  currentSalesProductId = null;
  currentSalesProductSlug = "";
  pendingMerchantAction = null;
  pendingRevokeKeyId = null;
  pendingLiquidPassword = null;
  salesProductsCache = null;

  // Clear user-specific localStorage
  localStorage.removeItem("depix-pixkey");
  localStorage.removeItem("depix-brswap-warned");
}

// Logout
document.getElementById("menu-logout")?.addEventListener("click", () => {
  closeMenu();
  const refreshToken = getRefreshToken();
  clearAuth();
  resetAppState();
  const loginSenha = document.getElementById("login-senha");
  if (loginSenha) loginSenha.value = "";
  navigate("#login");
  // Fire-and-forget API call after navigating
  apiFetch("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ action: "logout", refreshToken })
  }).catch(() => {});
});

// FAQ menu item
document.getElementById("menu-faq")?.addEventListener("click", () => {
  closeMenu();
  navigate("#faq");
});

// Contact modal
document.getElementById("menu-contact")?.addEventListener("click", () => {
  closeMenu();
  setMsg("contact-msg", "");
  document.getElementById("contact-subject").value = "";
  document.getElementById("contact-message").value = "";
  document.getElementById("contact-modal").classList.remove("hidden");
});

document.getElementById("close-contact-modal")?.addEventListener("click", () => {
  document.getElementById("contact-modal").classList.add("hidden");
});

document.getElementById("btn-send-contact")?.addEventListener("click", async () => {
  const assunto = document.getElementById("contact-subject").value.trim();
  const mensagem = document.getElementById("contact-message").value.trim();
  setMsg("contact-msg", "");

  if (!assunto || !mensagem) {
    setMsg("contact-msg", "Preencha o assunto e a mensagem");
    return;
  }

  const btn = document.getElementById("btn-send-contact");
  btn.disabled = true;
  btn.innerText = "Enviando…";

  try {
    const user = getUser();
    const res = await apiFetch("/api/contact", {
      method: "POST",
      body: JSON.stringify({
        assunto,
        mensagem,
        email: user?.email || "",
        usuario: user?.usuario || ""
      })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setMsg("contact-msg", data?.response?.errorMessage || "Erro ao enviar mensagem. Tente novamente.");
      return;
    }

    setMsg("contact-msg", "Mensagem enviada! Responderemos em breve.", true);
    setTimeout(() => {
      document.getElementById("contact-modal").classList.add("hidden");
    }, 1500);
  } catch {
    setMsg("contact-msg", "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Enviar";
  }
});

// FAQ accordion
document.querySelector(".faq-list")?.addEventListener("click", (e) => {
  const question = e.target.closest(".faq-question");
  if (!question) return;

  const item = question.closest(".faq-item");
  const answer = item.querySelector(".faq-answer");

  document.querySelectorAll(".faq-item.open").forEach((openItem) => {
    if (openItem !== item) {
      openItem.classList.remove("open");
      openItem.querySelector(".faq-answer")?.classList.add("hidden");
    }
  });

  item.classList.toggle("open");
  answer?.classList.toggle("hidden");
});

// =========================================
// ADDRESS MANAGEMENT
// =========================================

// ===================================================================
// Carteira Externa modal — unified add/switch/delete flow. Replaces the
// legacy #select-addr-modal + #add-addr-modal pair. The password-modal
// still gates switch + delete; address CRUD still lives in addresses.js.
// ===================================================================
// Renders the actual add/switch/delete modal. Callers that want the "are
// you sure you want to use external?" gate should use `openExternalWalletFlow`
// instead — that branches on wallet existence first.
function openExternalWalletModal() {
  const modal = document.getElementById("external-wallet-modal");
  if (!modal) return;
  const input = document.getElementById("new-addr-input");
  if (input) input.value = "";
  setMsg("add-addr-msg", "");
  renderAddressList();
  modal.classList.remove("hidden");
}

function closeExternalWalletModal() {
  document.getElementById("external-wallet-modal")?.classList.add("hidden");
}

function openExternalWalletIntroModal() {
  document.getElementById("external-wallet-intro-modal")?.classList.remove("hidden");
}

function closeExternalWalletIntroModal() {
  document.getElementById("external-wallet-intro-modal")?.classList.add("hidden");
}

// When the user has an integrated wallet, clicking "Carteira Externa" first
// lands on the intro modal that explains the trade-off and pushes them back
// to the integrated flow by default. The advanced path still reaches the
// full address-management modal. Users without a wallet skip the intro —
// external is the only option they have, no need to warn them against it.
async function openExternalWalletFlow() {
  closeMenu();
  const hasWallet = await hasWalletFast();
  if (hasWallet) {
    openExternalWalletIntroModal();
    return;
  }
  openExternalWalletModal();
}

document.getElementById("menu-carteira-externa")?.addEventListener("click", () => { void openExternalWalletFlow(); });
document.getElementById("external-wallet-cancel")?.addEventListener("click", closeExternalWalletModal);

// Commit CTA — user explicitly adopts external as the active destination.
// Different from the per-form home tile toggle (which is lightweight and
// reversible per navigation): this flips the global destination AND forces
// a refresh that hides the wallet toggle while keeping the wallet data in
// IDB untouched. The user can come back through Menu → Minha Carteira →
// Carteira Integrada → "Acessar minha carteira".
document.getElementById("external-wallet-commit")?.addEventListener("click", () => {
  writeHomeDestinationChoice("external");
  closeExternalWalletModal();
  // If we're currently on the wallet tab, refreshWalletModeAvailability will
  // force a switch back to deposit since the toggle is about to disappear.
  void refreshWalletModeAvailability();
  showToast("Agora você está usando a Carteira Externa.");
});

// Primary CTA on the intro modal — user confirms they want to stay with the
// integrated wallet. Persist the wallet preference + navigate to home in
// wallet mode so the change is immediately visible.
document.getElementById("external-wallet-intro-continue")?.addEventListener("click", () => {
  writeHomeDestinationChoice("wallet");
  closeExternalWalletIntroModal();
  try { localStorage.setItem("depix-home-mode", "wallet"); } catch { /* private mode */ }
  // Same navigate-no-op-when-on-home dance as the integrated-wallet-access
  // handler: call switchMode() directly when the hash already points at home.
  if (window.location.hash === "#home" || window.location.hash === "") {
    switchMode("wallet");
  } else {
    navigate("#home");
  }
  void refreshHomeDestination();
});

// Secondary CTA — user acknowledges the warning and drops into the full
// add/switch/delete modal.
document.getElementById("external-wallet-intro-proceed")?.addEventListener("click", () => {
  closeExternalWalletIntroModal();
  openExternalWalletModal();
});

function renderAddressList() {
  const container = document.getElementById("addr-list");
  const addresses = getAddresses();
  const selected = getSelectedAddress();

  if (addresses.length === 0) {
    container.innerHTML = toTrustedHTML('<p class="info-text">Nenhum endereço adicionado ainda. Use o campo acima para cadastrar o primeiro.</p>');
    return;
  }

  container.innerHTML = toTrustedHTML(addresses.map(addr => {
    const isSelected = addr === selected;
    const safe = escapeHtml(addr);
    return `
      <div class="addr-list-item${isSelected ? " selected" : ""}" data-addr="${safe}">
        <div class="addr-radio"></div>
        <span class="addr-text" title="${safe}">${escapeHtml(abbreviateAddress(addr))}</span>
        <button class="addr-delete" data-delete="${safe}" title="Remover">🗑</button>
      </div>
    `;
  }).join(""));

  container.querySelectorAll(".addr-list-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("addr-delete")) return;
      const addr = item.dataset.addr;
      const current = getSelectedAddress();

      if (addr !== current) {
        pendingAddressChange = addr;
        // Leave the external modal open — the password modal stacks on top
        // (later in the DOM + higher z-index). On confirm/cancel the user
        // lands back on an already-visible, freshly-rendered address list.
        document.getElementById("password-confirm-input").value = "";
        setMsg("password-modal-msg", "");
        document.querySelector("#password-modal h2").textContent = "Confirmar alteração";
        document.querySelector("#password-modal .info-text").textContent = "Para trocar o endereço selecionado, confirme sua senha.";
        document.getElementById("password-modal").classList.remove("hidden");
      }
    });
  });

  container.querySelectorAll(".addr-delete").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingAddressDelete = btn.dataset.delete;
      // Keep external modal open; password modal stacks above.
      document.getElementById("password-confirm-input").value = "";
      setMsg("password-modal-msg", "");
      document.querySelector("#password-modal h2").textContent = "Confirmar exclusão";
      document.querySelector("#password-modal .info-text").textContent = "Para excluir o endereço selecionado, confirme sua senha.";
      document.getElementById("password-modal").classList.remove("hidden");
    });
  });
}

// Confirm password for address change
document.getElementById("btn-confirm-password")?.addEventListener("click", async () => {
  const senha = document.getElementById("password-confirm-input").value;
  setMsg("password-modal-msg", "");

  if (!senha) {
    setMsg("password-modal-msg", "Informe sua senha");
    return;
  }

  const btn = document.getElementById("btn-confirm-password");
  btn.disabled = true;
  btn.innerText = "Confirmando…";

  try {
    const res = await apiFetch("/api/auth/verify-password", {
      method: "POST",
      body: JSON.stringify({ senha })
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("password-modal-msg", data?.response?.errorMessage || "Senha incorreta");
      return;
    }

    if (pendingAddressDelete) {
      removeAddress(pendingAddressDelete);
      pendingAddressDelete = "";
      document.getElementById("password-modal").classList.add("hidden");
      renderAddressList();
      updateAddrDisplay();
      if (!hasAddresses()) navigate("#no-address");
      showToast("Endereço removido com sucesso");
    } else {
      setSelectedAddress(pendingAddressChange);
      pendingAddressChange = "";
      document.getElementById("password-modal").classList.add("hidden");
      // Re-render so the radio state reflects the new selection — the user
      // is still looking at the external-wallet modal (it was never closed).
      renderAddressList();
      updateAddrDisplay();
      showToast("Endereço alterado com sucesso");
    }
  } catch (e) {
    setMsg("password-modal-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Confirmar";
  }
});

document.getElementById("close-password-modal")?.addEventListener("click", () => {
  pendingAddressChange = "";
  pendingAddressDelete = "";
  document.getElementById("password-modal").classList.add("hidden");
});

// Onboarding (empty state) — a dropdown + dynamic hint + single Continue
// button. Selecting "integrada" sends the user through the educational
// modal; "externa" drops straight into the unified address-management modal.
const ONBOARDING_HINTS = Object.freeze({
  integrada: "Criada direto no app em menos de 1 minuto. Protegida por PIN e biometria. Recomendada para a maioria dos usuários.",
  externa: "Para quem já tem carteira em outro app (SideSwap, Jade, Ledger, Green) ou prefere usar hardware wallet."
});
function updateOnboardingHint() {
  const select = document.getElementById("onboarding-choice");
  const hint = document.getElementById("onboarding-choice-hint");
  if (!select || !hint) return;
  hint.textContent = ONBOARDING_HINTS[select.value] || "";
}
document.getElementById("onboarding-choice")?.addEventListener("change", updateOnboardingHint);
document.getElementById("btn-onboarding-continue")?.addEventListener("click", () => {
  const select = document.getElementById("onboarding-choice");
  const choice = select?.value || "integrada";
  if (choice === "externa") {
    openExternalWalletModal();
  } else {
    void openIntegratedWalletModal();
  }
});
// Save button inside Carteira Externa modal. On success we re-render the
// in-modal list so the new entry shows up immediately — we do NOT close
// the modal, unlike the legacy single-input flow.
document.getElementById("btn-save-addr")?.addEventListener("click", () => {
  const input = document.getElementById("new-addr-input");
  const addr = input?.value.trim() || "";
  setMsg("add-addr-msg", "");

  const addrResult = validateLiquidAddress(addr);
  if (!addrResult.valid) {
    setMsg("add-addr-msg", addrResult.error);
    return;
  }

  const added = addAddress(addr);
  if (!added) {
    setMsg("add-addr-msg", "Este endereço já está cadastrado");
    return;
  }

  if (input) input.value = "";
  renderAddressList();
  updateAddrDisplay();
  showToast("Endereço cadastrado com sucesso");

  // If the user came from the onboarding empty-state, we silently promote
  // the hash to #home in the background so Cancel/Commit don't drop them
  // back there. Modal stays open — user decides when to close.
  if (window.location.hash === "#no-address") {
    navigate("#home");
  }
});

// QR scanner button in the "Adicionar novo endereço" section. Validates the
// scanned text via parseLiquidUri (accepts plain Liquid addresses or BIP21
// URIs), fills the input, and lets the user confirm by clicking "Salvar".
// Hidden when getUserMedia is unavailable (older browsers / no permission).
if (!isQrScannerSupported()) {
  document.getElementById("new-addr-scan")?.classList.add("hidden");
}
document.getElementById("new-addr-scan")?.addEventListener("click", async () => {
  let parsed = null;
  try {
    await scanQRCode({
      title: "Escanear endereço Liquid",
      hint: "Aponte para o QR do endereço de destino.",
      validate: (text) => {
        const p = parseLiquidUri(text);
        if (!p.valid) return { ok: false, error: p.error };
        parsed = p;
        return { ok: true };
      },
    });
  } catch (err) {
    if (err && (err.code === QR_SCANNER_ERRORS.CANCELLED || err.code === QR_SCANNER_ERRORS.ABORTED)) return;
    // Permission / camera errors already surface their own in-modal state.
    return;
  }
  if (!parsed) return;
  const input = document.getElementById("new-addr-input");
  if (input) input.value = parsed.data.address;
  setMsg("add-addr-msg", "");
  showToast("QR code lido.");
});

// =========================================
// REPORT POPOVER (shared logic)
// =========================================

function initReportPopover(btnId, popoverId, startId, endId, submitId, msgId, tipo) {
  const btn = document.getElementById(btnId);
  const popover = document.getElementById(popoverId);
  if (!btn || !popover) return;

  // Toggle popover on button click
  btn.addEventListener("click", () => {
    const isOpen = !popover.classList.contains("hidden");
    // Close all other popovers first
    document.querySelectorAll(".report-popover").forEach(p => p.classList.add("hidden"));
    if (isOpen) return;
    // Set default dates: last 30 days
    const fmt = d => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
    const startInput = document.getElementById(startId);
    const endInput = document.getElementById(endId);
    if (startInput && !startInput.value) startInput.value = fmt(thirtyDaysAgo);
    if (endInput && !endInput.value) endInput.value = fmt(now);
    setMsg(msgId, "");
    popover.classList.remove("hidden");
  });

  // Popover close-on-outside-click is handled by the delegated listener below

  // Submit handler
  document.getElementById(submitId)?.addEventListener("click", async () => {
    const dataInicio = document.getElementById(startId)?.value;
    const dataFim = document.getElementById(endId)?.value;
    setMsg(msgId, "");

    if (!dataInicio || !dataFim) {
      setMsg(msgId, "Selecione as datas de início e fim");
      return;
    }
    const start = new Date(dataInicio);
    const end = new Date(dataFim);
    if (end < start) {
      setMsg(msgId, "A data final deve ser posterior à data inicial");
      return;
    }
    if ((end - start) / (1000 * 60 * 60 * 24) > 366) {
      setMsg(msgId, "O intervalo máximo é de 1 ano");
      return;
    }

    const submitBtn = document.getElementById(submitId);
    submitBtn.disabled = true;
    submitBtn.innerText = "Solicitando…";

    try {
      const res = await apiFetch("/api/reports", {
        method: "POST",
        body: JSON.stringify({ tipo, dataInicio, dataFim })
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(msgId, data?.response?.errorMessage || "Erro ao solicitar relatório");
        return;
      }
      const user = getUser();
      setMsg(msgId, `Será enviado para ${user?.email || "seu e-mail"}.`, true);
    } catch (e) {
      setMsg(msgId, e.message || "Sem conexão. Verifique sua internet.");
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = "Enviar por e-mail";
    }
  });
}

initReportPopover(
  "extrato-download-report", "extrato-report-popover",
  "extrato-report-start", "extrato-report-end",
  "extrato-report-submit", "extrato-report-msg", "extrato"
);

initReportPopover(
  "commission-download-report", "commission-report-popover",
  "commission-report-start", "commission-report-end",
  "commission-report-submit", "commission-report-msg", "comissao"
);

initReportPopover(
  "sales-download-report", "sales-report-popover",
  "sales-report-start", "sales-report-end",
  "sales-report-submit", "sales-report-msg", "checkouts"
);

// Single delegated close-on-outside-click for all popovers
document.addEventListener("click", (e) => {
  document.querySelectorAll(".report-popover-wrap").forEach(wrap => {
    const popover = wrap.querySelector(".report-popover");
    if (popover && !popover.classList.contains("hidden") && !wrap.contains(e.target)) {
      popover.classList.add("hidden");
    }
  });
});

// ===== AFILIADOS =====

document.getElementById("menu-affiliates")?.addEventListener("click", () => {
  closeMenu();
  navigate("#affiliates");
});

document.getElementById("menu-commissions")?.addEventListener("click", () => {
  closeMenu();
  navigate("#commissions");
});

async function loadAffiliateData() {
  const loading = document.getElementById("affiliates-loading");
  const content = document.getElementById("affiliates-content");

  loading.classList.remove("hidden");
  content.classList.add("hidden");
  setMsg("affiliates-msg", "");

  try {
    const res = await apiFetch("/api/status?type=affiliates");
    const data = await res.json();

    if (!res.ok) {
      setMsg("affiliates-msg", data?.response?.errorMessage || "Erro ao carregar dados de afiliado");
      return;
    }

    document.getElementById("affiliate-link").value = buildAffiliateLink(data.referralCode);
    const sharePercent = data.platformFeePercent ? Math.round(data.commissionRate / data.platformFeePercent * 100) : data.commissionRate;
    document.getElementById("affiliate-commission-rate").innerText = `${sharePercent}%`;

    // Update commission modal with actual values
    const rateModal = document.getElementById("rate-info-modal");
    if (rateModal) {
      rateModal.querySelector(".info-text-fee").innerText = `${data.platformFeePercent}%`;
      rateModal.querySelector(".info-text-share").innerText = `${sharePercent}%`;
      const exDeposit = 1000;
      const exFee = exDeposit * data.platformFeePercent / 100;
      const exComm = exFee * sharePercent / 100;
      rateModal.querySelector(".info-text-ex-fee").innerText = formatDePix(exFee * 100);
      rateModal.querySelector(".info-text-ex-comm").innerText = formatDePix(exComm * 100);
    }
    document.getElementById("affiliate-volume").innerText = formatBRL(data.totalVolumeCents);
    document.getElementById("affiliate-commission-value").innerText = formatDePix(data.pendingCommissionCents);
    document.getElementById("affiliate-paid-value").innerText = formatDePix(data.totalPaidCents);

    // Show/hide payment request button
    const paySection = document.getElementById("payment-request-section");
    if (paySection) paySection.classList.toggle("hidden", !data.canRequestPayment);

    content.classList.remove("hidden");
  } catch (e) {
    setMsg("affiliates-msg", e.message || "Sem conexão. Verifique sua internet.");
  } finally {
    loading.classList.add("hidden");
  }
}

async function loadCommissionsData() {
  const loading = document.getElementById("commissions-loading");
  const content = document.getElementById("commissions-content");
  if (!loading || !content) return;

  loading.classList.remove("hidden");
  content.classList.add("hidden");

  try {
    const res = await apiFetch("/api/status?type=affiliates");
    const data = await res.json();
    if (!res.ok) {
      loading.classList.add("hidden");
      showToast("Erro ao carregar comissões. Tente novamente.");
      return;
    }
    renderReferrals(data.referrals);
    renderPayments(data.payments);
    content.classList.remove("hidden");
    loading.classList.add("hidden");
  } catch {
    loading.classList.add("hidden");
    showToast("Erro ao carregar comissões. Tente novamente.");
  }
}

function renderReferrals(referrals) {
  const list = document.getElementById("affiliates-list");
  const empty = document.getElementById("affiliates-empty");

  const { html, isEmpty } = renderReferralsHTML(referrals, formatDateShort);
  list.innerHTML = toTrustedHTML(html);
  empty.classList.toggle("hidden", !isEmpty);
}

document.getElementById("btn-copy-affiliate")?.addEventListener("click", async () => {
  const link = document.getElementById("affiliate-link").value;
  const btn = document.getElementById("btn-copy-affiliate");
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copiado!");
    btn.innerText = "Copiado!";
    setTimeout(() => { btn.innerText = "Copiar"; }, 2000);
  } catch {
    showToast("Não foi possível copiar.");
  }
});

function renderPayments(payments) {
  const list = document.getElementById("affiliate-payments-list");
  const empty = document.getElementById("affiliate-payments-empty");
  if (!list) return;

  if (!payments || payments.length === 0) {
    list.innerHTML = toTrustedHTML("");
    if (empty) empty.classList.remove("hidden");
    return;
  }

  if (empty) empty.classList.add("hidden");
  list.innerHTML = toTrustedHTML(payments.map(p => {
    const amount = escapeHtml(formatDePix(p.amountCents));
    const date = escapeHtml(formatDateShort(p.paidAt));
    const addr = p.liquidAddress || "";
    const addrShort = escapeHtml(addr.length > 14 ? `${addr.slice(0, 8)}...${addr.slice(-4)}` : addr);
    // Validate txUrl is a safe https URL before putting in href
    let txLink = "";
    if (p.liquidTxUrl && typeof p.liquidTxUrl === "string" && p.liquidTxUrl.startsWith("https://")) {
      txLink = `<a href="${escapeHtml(p.liquidTxUrl)}" target="_blank" rel="noopener" class="tx-link">Ver TX</a>`;
    }
    return `
      <div class="referral-item payment-item">
        <div class="payment-info-row">
          <span class="referral-name">${amount}</span>
          <span class="referral-date">${date}</span>
        </div>
        <div class="payment-info-row">
          <span class="payment-addr">${addrShort}</span>
          ${txLink}
        </div>
      </div>
    `;
  }).join(""));
}

// Commission rate info modal
document.getElementById("affiliate-rate-info")?.addEventListener("click", () => {
  document.getElementById("rate-info-modal")?.classList.remove("hidden");
});
document.getElementById("close-rate-info")?.addEventListener("click", () => {
  document.getElementById("rate-info-modal")?.classList.add("hidden");
});

// Total paid info modal
document.getElementById("affiliate-paid-info")?.addEventListener("click", () => {
  document.getElementById("paid-info-modal")?.classList.remove("hidden");
});
document.getElementById("close-paid-info")?.addEventListener("click", () => {
  document.getElementById("paid-info-modal")?.classList.add("hidden");
});

document.getElementById("affiliate-volume-info")?.addEventListener("click", () => {
  document.getElementById("volume-info-modal")?.classList.remove("hidden");
});

document.getElementById("close-volume-info")?.addEventListener("click", () => {
  document.getElementById("volume-info-modal")?.classList.add("hidden");
});

// Commission info modal
document.getElementById("affiliate-commission-info")?.addEventListener("click", () => {
  document.getElementById("commission-info-modal")?.classList.remove("hidden");
});
document.getElementById("close-commission-info")?.addEventListener("click", () => {
  document.getElementById("commission-info-modal")?.classList.add("hidden");
});


// ===== Payment request flow =====
// Module-scoped pending address replaces the prior `window._paymentAddress`
// global. Cleared on cancel + after a successful submit so a stale value
// from a previous attempt can never silently feed a new request.
let pendingPaymentAddress = null;

document.getElementById("btn-request-payment")?.addEventListener("click", () => {
  document.getElementById("payment-warning-modal")?.classList.remove("hidden");
});

document.getElementById("btn-payment-warning-ok")?.addEventListener("click", async () => {
  document.getElementById("payment-warning-modal")?.classList.add("hidden");
  setMsg("payment-address-msg", "");
  await paymentAddrDropdown.populate();
  document.getElementById("payment-address-modal")?.classList.remove("hidden");
});

document.getElementById("btn-payment-address-cancel")?.addEventListener("click", () => {
  document.getElementById("payment-address-modal")?.classList.add("hidden");
  pendingPaymentAddress = null;
});

document.getElementById("btn-payment-address-submit")?.addEventListener("click", async () => {
  const source = paymentAddrDropdown.getSource();
  setMsg("payment-address-msg", "");
  if (!source) { setMsg("payment-address-msg", "Configure sua carteira primeiro."); return; }
  const { addr, error } = await resolveDestinationAddress(source);
  if (error === "wallet-resolve-failed") {
    showWalletErrorModal({
      onSwitchToExternal: () => paymentAddrDropdown.selectOption("external"),
    });
    return;
  }
  if (!addr) { setMsg("payment-address-msg", "Configure sua carteira primeiro."); return; }
  const v = validateLiquidAddress(addr);
  if (!v.valid) { setMsg("payment-address-msg", v.error); return; }

  pendingPaymentAddress = addr;
  document.getElementById("payment-address-modal")?.classList.add("hidden");
  const amount = document.getElementById("affiliate-commission-value").innerText;
  document.getElementById("payment-confirm-amount").innerText = amount;
  document.getElementById("payment-confirm-address").innerText = abbreviateAddress(addr);
  document.getElementById("payment-confirm-modal")?.classList.remove("hidden");
});

document.getElementById("btn-payment-confirm-cancel")?.addEventListener("click", () => {
  document.getElementById("payment-confirm-modal")?.classList.add("hidden");
  pendingPaymentAddress = null;
});

document.getElementById("btn-payment-confirm")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-payment-confirm");
  if (!pendingPaymentAddress) {
    showToast("Selecione um endereço primeiro.");
    return;
  }
  btn.disabled = true;
  btn.innerText = "Enviando...";
  try {
    const res = await apiFetch("/api/reports", {
      method: "POST",
      body: JSON.stringify({
        tipo: "solicitar_comissao",
        liquidAddress: pendingPaymentAddress
      })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data?.response?.errorMessage || "Erro ao solicitar pagamento");
      return;
    }
    document.getElementById("payment-confirm-modal")?.classList.add("hidden");
    pendingPaymentAddress = null;
    showToast("Solicitação enviada com sucesso!");
    loadAffiliateData();
  } catch (e) {
    showToast(e.message || "Erro de conexão");
  } finally {
    btn.disabled = false;
    btn.innerText = "Sim, solicitar";
  }
});

// Limit explanation modal
function showLimitModal() {
  document.getElementById("limit-modal")?.classList.remove("hidden");
}
document.getElementById("close-limit-modal")?.addEventListener("click", () => {
  document.getElementById("limit-modal")?.classList.add("hidden");
});


// =========================================
// TRANSACTIONS
// =========================================

const DEPOSIT_STATUS_LABELS = {
  pending: "Pendente", depix_sent: "Concluído", under_review: "Em análise",
  canceled: "Cancelado", error: "Erro", refunded: "Reembolsado",
  expired: "Expirado", pending_pix2fa: "Aguardando 2FA", delayed: "Processando (D+1)"
};

const WITHDRAW_STATUS_LABELS = {
  unsent: "Aguardando", sending: "Enviando", sent: "Enviado",
  error: "Erro", cancelled: "Cancelado", refunded: "Reembolsado",
  expired: "Expirado"
};

const NON_TERMINAL_STATUSES = new Set([
  "pending", "sending", "unsent", "under_review", "pending_pix2fa", "delayed"
]);

function statusColor(status) {
  if (["depix_sent", "sent"].includes(status)) return "status-green";
  if (["pending", "sending", "pending_pix2fa", "delayed"].includes(status)) return "status-yellow";
  if (["under_review"].includes(status)) return "status-orange";
  if (["canceled", "cancelled", "error"].includes(status)) return "status-red";
  if (status === "refunded") return "status-blue";
  return "status-gray";
}

// Parse database timestamp (stored as UTC without Z suffix) into a Date
function parseUTC(isoStr) {
  const s = String(isoStr).trim();
  if (s.includes("Z") || s.includes("+")) return new Date(s);
  return new Date(s.replace(" ", "T") + "Z");
}

function formatDateShort(isoStr) {
  if (!isoStr) return "";
  return parseUTC(isoStr).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Sao_Paulo" });
}

// Convert UTC ISO string to YYYY-MM-DD in São Paulo timezone
function toBRDate(isoStr) {
  if (!isoStr) return "";
  return parseUTC(isoStr).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function abbreviateHash(str, prefixLen = 8, suffixLen = 6) {
  if (!str || str.length <= prefixLen + suffixLen + 3) return str || "";
  return str.slice(0, prefixLen) + "…" + str.slice(-suffixLen);
}

// escapeHtml imported from utils.js

function buildTxDetails(tx) {
  const copyDetails = [];
  let txidHtml = "";

  if (tx.payer_name) {
    copyDetails.push({ label: "Pagador", value: escapeHtml(tx.payer_name), full: tx.payer_name });
  }
  if (tx.chave_pix) {
    copyDetails.push({ label: "Chave PIX", value: escapeHtml(abbreviateHash(tx.chave_pix, 10, 4)), full: tx.chave_pix, mono: true });
  }
  if (tx.customer_message) {
    copyDetails.push({ label: "Msg", value: escapeHtml(tx.customer_message), full: tx.customer_message });
  }
  if (tx.endereco_liquid) {
    copyDetails.push({ label: "Endereço", value: escapeHtml(abbreviateHash(tx.endereco_liquid)), full: tx.endereco_liquid, mono: true });
  }
  if (tx.blockchain_tx_id) {
    const txid = escapeHtml(tx.blockchain_tx_id);
    const url = `https://blockstream.info/liquid/tx/${txid}`;
    const externalIcon = '<svg class="external-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    txidHtml = `<span class="transaction-detail mono"><a href="${url}" target="_blank" rel="noopener"><span class="transaction-detail-label">Blockchain TXID:</span> <span class="transaction-detail-value">${escapeHtml(abbreviateHash(tx.blockchain_tx_id))}</span>${externalIcon}</a></span>`;
  }

  if (copyDetails.length === 0 && !txidHtml) return "";

  const copyIcon = '<svg class="copy-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const items = copyDetails.map(d => {
    const monoClass = d.mono ? " mono" : "";
    return `<span class="transaction-detail copyable${monoClass}" title="Copiar: ${escapeHtml(d.full)}" data-copy="${escapeHtml(d.full)}"><span class="transaction-detail-label">${d.label}:</span> <span class="transaction-detail-value">${d.value}</span>${copyIcon}</span>`;
  }).join("");

  return `<div class="transaction-details">${items}${txidHtml}</div>`;
}

let allTransactions = [];
let filteredTransactions = [];
let displayedCount = 0;
const PAGE_SIZE = 50;
let txObserver = null;

function setupTransactionsObserver() {
  if (txObserver) txObserver.disconnect();
  const list = document.getElementById("transactions-list");
  const sentinel = document.getElementById("transactions-sentinel");
  if (!list || !sentinel) return;
  txObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && displayedCount < filteredTransactions.length) {
      renderNextPage();
    }
  }, { root: list, rootMargin: "0px 0px 200px 0px" });
  txObserver.observe(sentinel);
}

async function loadTransactions() {
  const loading = document.getElementById("transactions-loading");

  loading.classList.remove("hidden");
  setMsg("transactions-msg", "");
  const list = document.getElementById("transactions-list");
  list.innerHTML = toTrustedHTML('<div id="transactions-sentinel" aria-hidden="true" style="height:1px"></div>');
  document.getElementById("transactions-empty").classList.add("hidden");

  try {
    const res = await apiFetch("/api/status?type=all");
    const data = await res.json();

    if (!res.ok) {
      setMsg("transactions-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao carregar transações");
      return;
    }

    allTransactions = data.transactions || [];
    applyFilters();

    // Auto-refresh if there are non-terminal transactions
    stopTransactionsPolling();
    const hasPending = allTransactions.some(tx => NON_TERMINAL_STATUSES.has(tx.status));
    if (hasPending) {
      transactionsPollingInterval = setInterval(async () => {
        try {
          const r = await apiFetch("/api/status?type=all");
          const d = await r.json();
          if (r.ok) {
            allTransactions = d.transactions || [];
            applyFilters();
            if (!allTransactions.some(tx => NON_TERMINAL_STATUSES.has(tx.status))) {
              stopTransactionsPolling();
            }
          }
        } catch { /* ignore polling errors */ }
      }, 30000);
    }

  } catch (e) {
    setMsg("transactions-msg", e.message || "Erro ao carregar transações");
  } finally {
    loading.classList.add("hidden");
  }
}

function applyFilters() {
  // Scoped to [data-filter-type] because the wallet-transactions view reuses
  // the .extrato-pill class with different data attrs — an unscoped selector
  // would read the first active .extrato-pill in DOM order regardless of view.
  const type = document.querySelector(".extrato-pill[data-filter-type].active")?.dataset.filterType || "all";
  const status = document.getElementById("filter-status")?.value || "";
  const startDate = document.getElementById("filter-start-date")?.value || "";
  const endDate = document.getElementById("filter-end-date")?.value || "";
  const search = (document.getElementById("filter-search")?.value || "").trim().toLowerCase();

  filteredTransactions = allTransactions.filter(tx => {
    if (type !== "all" && tx.tipo !== type) return false;
    if (status && tx.status !== status) return false;
    if (startDate || endDate) {
      const txDate = toBRDate(tx.criado_em);
      if (startDate && txDate < startDate) return false;
      if (endDate && txDate > endDate) return false;
    }
    if (search) {
      const fields = [
        tx.blockchain_tx_id, tx.payer_name, tx.customer_message,
        tx.endereco_liquid, tx.chave_pix
      ];
      const match = fields.some(f => f && String(f).toLowerCase().includes(search));
      if (!match) return false;
    }
    return true;
  });

  displayedCount = 0;
  const list = document.getElementById("transactions-list");
  list.innerHTML = toTrustedHTML('<div id="transactions-sentinel" aria-hidden="true" style="height:1px"></div>');
  renderNextPage();
  setupTransactionsObserver();
}

function renderNextPage() {
  const list = document.getElementById("transactions-list");
  const empty = document.getElementById("transactions-empty");
  const sentinel = document.getElementById("transactions-sentinel");

  const nextBatch = filteredTransactions.slice(displayedCount, displayedCount + PAGE_SIZE);

  if (displayedCount === 0 && nextBatch.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  const hash = window.location.hash;
  const params = new URLSearchParams(hash.split("?")[1] || "");
  const highlightId = params.get("id") || "";

  const html = nextBatch.map(tx => {
    const isDeposit = tx.tipo === "deposit";
    const typeClass = isDeposit ? "deposit" : "withdraw";
    const typeLabel = isDeposit ? "Depósito" : "Saque";
    const st = tx.status || (isDeposit ? "pending" : "unsent");
    const statusLabel = isDeposit
      ? (DEPOSIT_STATUS_LABELS[st] || st)
      : (WITHDRAW_STATUS_LABELS[st] || st);
    const amount = isDeposit
      ? formatBRL(tx.valor_centavos)
      : formatBRL(tx.payout_amount_centavos || tx.deposit_amount_centavos);
    const txId = isDeposit ? tx.qr_id : tx.withdrawal_id;
    const isHighlighted = highlightId && txId === highlightId;

    return `<div class="transaction-item${isHighlighted ? " highlight" : ""}" data-tx-id="${txId || ""}">
      <span class="transaction-type ${typeClass}">${typeLabel}</span>
      <div class="transaction-info">
        <span class="transaction-amount">${amount}</span>
        <span class="transaction-date">${formatDateShort(tx.criado_em)}</span>
      </div>
      <span class="transaction-status ${statusColor(st)}">${statusLabel}</span>
      ${buildTxDetails(tx)}
    </div>`;
  }).join("");

  if (sentinel) {
    sentinel.insertAdjacentHTML("beforebegin", toTrustedHTML(html));
  } else {
    list.insertAdjacentHTML("beforeend", toTrustedHTML(html));
  }

  displayedCount += nextBatch.length;


  // Scroll to highlighted on first render
  if (displayedCount <= PAGE_SIZE && highlightId) {
    const el = list.querySelector(`[data-tx-id="${highlightId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function stopTransactionsPolling() {
  if (transactionsPollingInterval) {
    clearInterval(transactionsPollingInterval);
    transactionsPollingInterval = null;
  }
  if (txObserver) {
    txObserver.disconnect();
    txObserver = null;
  }
}

// Pause polling when tab/PWA is hidden (minimized, screen off, switched app).
// Resume when visible again. Prevents wasting Redis commands in background.
document.addEventListener("visibilitychange", () => {
  const h = window.location.hash.split("?")[0];
  if (document.hidden) {
    stopTransactionsPolling();
    if (typeof stopSalesPolling === "function") stopSalesPolling();
  } else if (h === "#transactions") {
    loadTransactions();
  } else if (h === "#merchant-sales" && typeof loadSalesView === "function") {
    loadSalesView();
  }
});

// Transactions menu button
document.getElementById("menu-transactions")?.addEventListener("click", () => {
  closeMenu();
  navigate("#transactions");
});

// ===== Wallet bundle — lazy bootstrap =====
//
// The wallet bundle is large (~5MB of LWK WASM) and only needed once the
// user actually opens the wallet. We lazy-load it on first entry to a
// `#wallet-*` route: the stubs below fire once, load the bundle, register
// the real handlers (which overwrite these stubs), and re-dispatch the
// hashchange so the real handler runs.
let walletBootstrapPromise = null;
const WALLET_ROUTE_HASHES = [
  "#wallet-gate",
  "#wallet-create-intro",
  "#wallet-create-seed",
  "#wallet-create-verify",
  "#wallet-create-pin",
  "#wallet-create-biometric",
  "#wallet-create-done",
  "#wallet-restore-input",
  "#wallet-restore-confirm-identity",
  "#wallet-restore-pin",
  "#wallet-restore-biometric",
  "#wallet-restore-done",
  "#wallet-receive",
  "#wallet-send",
  "#wallet-send-success",
  "#wallet-transactions",
  "#wallet-settings"
];

async function ensureWalletBootstrapped() {
  if (!walletBootstrapPromise) {
    walletBootstrapPromise = (async () => {
      const bundle = await loadWalletBundle();
      bundle.registerWalletRoutes({
        route,
        navigate,
        wallet: bundle.getDefaultWallet(),
        quotes: bundle.getDefaultQuotesClient(),
        showToast
      });
    })().catch(err => {
      walletBootstrapPromise = null;
      throw err;
    });
  }
  return walletBootstrapPromise;
}

function makeWalletRouteStub() {
  return async () => {
    try {
      await ensureWalletBootstrapped();
      // registerWalletRoutes overwrote the handler for this hash; fire a
      // synthetic hashchange so the real handler runs for the current view.
      window.dispatchEvent(new Event("hashchange"));
    } catch (err) {
      console.error("wallet bundle load failed", err);
      // Deep-link or back-button entry may land the user on any wallet-*
      // view — not just #wallet-gate. Surface a toast regardless, then route
      // to the gate so the inline error slot is visible too.
      showToast("Não foi possível carregar a carteira. Verifique sua conexão e tente novamente.");
      navigate("#wallet-gate");
      const msg = document.getElementById("wallet-gate-msg");
      if (msg) {
        msg.textContent = "Não foi possível carregar a carteira. Verifique sua conexão e tente novamente.";
        msg.classList.add("error");
      }
    }
  };
}

for (const hash of WALLET_ROUTE_HASHES) {
  route(hash, makeWalletRouteStub());
}

// ===================================================================
// Carteira Integrada modal — educational copy + state-aware CTAs.
//   * no wallet + kill-switch OFF   → Criar + Restaurar
//   * no wallet + kill-switch ON    → both disabled + maintenance note
//   * wallet exists                  → Acessar minha carteira
// Uses hasWalletInIdbRaw() so the wallet bundle is NOT loaded just to
// show the modal — matches the Sub-fase 1 lazy-load contract.
// ===================================================================
async function openIntegratedWalletModal() {
  closeMenu();
  const modal = document.getElementById("integrated-wallet-modal");
  if (!modal) return;

  const accessBtn = document.getElementById("integrated-wallet-access");
  const createBtn = document.getElementById("integrated-wallet-create");
  const restoreBtn = document.getElementById("integrated-wallet-restore");
  const maint = document.getElementById("integrated-wallet-maintenance");

  // Hidden by default; we reveal selectively.
  accessBtn?.classList.add("hidden");
  createBtn?.classList.add("hidden");
  restoreBtn?.classList.add("hidden");
  maint?.classList.add("hidden");
  if (createBtn) createBtn.disabled = false;
  if (restoreBtn) restoreBtn.disabled = false;

  const walletExists = await hasWalletFast();
  const walletEnabled = walletExists ? true : await isWalletFeatureEnabled();
  const plan = planIntegratedWallet({ walletExists, walletEnabled });

  if (accessBtn) accessBtn.classList.toggle("hidden", !plan.showAccess);
  if (createBtn) {
    createBtn.classList.toggle("hidden", !plan.showCreate);
    createBtn.disabled = plan.disableCreate;
  }
  if (restoreBtn) {
    restoreBtn.classList.toggle("hidden", !plan.showRestore);
    restoreBtn.disabled = plan.disableRestore;
  }
  if (maint) maint.classList.toggle("hidden", !plan.showMaintenance);

  modal.classList.remove("hidden");
}

function closeIntegratedWalletModal() {
  document.getElementById("integrated-wallet-modal")?.classList.add("hidden");
}

document.getElementById("menu-carteira-integrada")?.addEventListener("click", openIntegratedWalletModal);
document.getElementById("close-integrated-wallet")?.addEventListener("click", closeIntegratedWalletModal);

document.getElementById("integrated-wallet-access")?.addEventListener("click", () => {
  // Flip the destination back to wallet in case the user previously committed
  // to external — otherwise the wallet toggle would still be hidden and
  // switchMode("wallet") would try to activate a hidden tab.
  writeHomeDestinationChoice("wallet");
  try { localStorage.setItem("depix-home-mode", "wallet"); } catch { /* private mode */ }
  closeIntegratedWalletModal();
  // navigate("#home") is a no-op when we're already on #home, so rely on
  // switchMode() to actually flip the tab. When we're on another route
  // (e.g. #faq, #affiliates) the navigate below takes us home and the
  // route handler's `refreshWalletModeAvailability()` picks up the mode.
  void refreshWalletModeAvailability();
  if (window.location.hash === "#home" || window.location.hash === "") {
    switchMode("wallet");
  } else {
    navigate("#home");
  }
});
document.getElementById("integrated-wallet-create")?.addEventListener("click", () => {
  closeIntegratedWalletModal();
  navigate("#wallet-create-intro");
});
document.getElementById("integrated-wallet-restore")?.addEventListener("click", () => {
  closeIntegratedWalletModal();
  navigate("#wallet-restore-input");
});

// Restore-guide modal — shown from the wallet-home maintenance CTA when
// the kill-switch is ON. Mirrors #wallet-guide-modal's shape but teaches
// the RESTORE flow on SideSwap (user re-types the 12 words into SideSwap
// to regain control of funds while the integrated wallet is paused).
function openWalletRestoreGuide() {
  document.getElementById("wallet-restore-guide-modal")?.classList.remove("hidden");
}
function closeWalletRestoreGuide() {
  document.getElementById("wallet-restore-guide-modal")?.classList.add("hidden");
}
document.getElementById("wallet-home-maintenance-cta")?.addEventListener("click", openWalletRestoreGuide);
document.getElementById("close-wallet-restore-guide")?.addEventListener("click", closeWalletRestoreGuide);
// "Mostrar minhas 12 palavras" → close modal, navigate to wallet-settings,
// and flag the mount to auto-open the export (PIN) flow so the user lands
// two clicks away from their seed instead of three.
document.getElementById("btn-wallet-restore-guide-show-seed")?.addEventListener("click", () => {
  closeWalletRestoreGuide();
  try { localStorage.setItem("depix-pending-seed-export", "1"); }
  catch { /* private mode */ }
  navigate("#wallet-settings");
});

// Shared: collapse a filter panel after selection
function collapseFilterPanel(panelId, toggleId) {
  const panel = document.getElementById(panelId);
  const toggle = document.getElementById(toggleId);
  if (panel && !panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    toggle?.classList.remove("open");
  }
}

// Extrato: pill toggle filters (type).
// Scoped to `[data-filter-type]` so the wallet-transactions view (which
// reuses .extrato-pill visually but uses `[data-wallet-asset]` /
// `[data-wallet-direction]`) doesn't cross-wire into the extrato handler.
document.querySelectorAll(".extrato-pill[data-filter-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".extrato-pill[data-filter-type]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    applyFilters();
    updateFilterBadge();
    collapseFilterPanel("extrato-filter-panel", "extrato-filter-toggle");
  });
});

// Extrato: filter panel toggle
document.getElementById("extrato-filter-toggle")?.addEventListener("click", () => {
  const panel = document.getElementById("extrato-filter-panel");
  const toggle = document.getElementById("extrato-filter-toggle");
  const isOpen = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", isOpen);
  toggle.classList.toggle("open", !isOpen);
});

// Extrato: period preset logic
function getDateFromPeriod(period) {
  const fmt = d => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const todayStr = fmt(new Date());
  if (period === "today") return { start: todayStr, end: todayStr };
  const offsets = { "7d": 6, "30d": 29, "90d": 89 };
  if (offsets[period]) {
    const d = new Date();
    d.setDate(d.getDate() - offsets[period]);
    return { start: fmt(d), end: todayStr };
  }
  return { start: "", end: "" };
}

document.querySelectorAll(".extrato-period-btn[data-period]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".extrato-period-btn[data-period]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const period = btn.dataset.period;
    const customRange = document.getElementById("extrato-custom-range");
    const startInput = document.getElementById("filter-start-date");
    const endInput = document.getElementById("filter-end-date");

    if (period === "custom") {
      customRange?.classList.remove("hidden");
    } else {
      customRange?.classList.add("hidden");
      const { start, end } = getDateFromPeriod(period);
      if (startInput) startInput.value = start;
      if (endInput) endInput.value = end;
      collapseFilterPanel("extrato-filter-panel", "extrato-filter-toggle");
    }
    applyFilters();
    updateFilterBadge();
  });
});

// Extrato: update filter badge count
function updateFilterBadge() {
  const type = document.querySelector(".extrato-pill[data-filter-type].active")?.dataset.filterType || "all";
  const status = document.getElementById("filter-status")?.value || "";
  const period = document.querySelector(".extrato-period-btn[data-period].active")?.dataset.period || "all";
  const search = (document.getElementById("filter-search")?.value || "").trim();
  const count = (type !== "all" ? 1 : 0) + (status ? 1 : 0) + (period !== "all" ? 1 : 0) + (search ? 1 : 0);
  const badge = document.getElementById("extrato-filter-badge");
  const toggle = document.getElementById("extrato-filter-toggle");
  const clearBtn = document.getElementById("extrato-clear-filters");
  if (badge) {
    badge.textContent = count;
    badge.classList.toggle("hidden", count === 0);
  }
  if (toggle) toggle.classList.toggle("active", count > 0);
  if (clearBtn) clearBtn.classList.toggle("hidden", count === 0);
}

// Extrato: search input with debounce
let searchTimeout = null;
function updateExtratoSearchClear() {
  const val = document.getElementById("filter-search")?.value || "";
  document.getElementById("filter-search-clear")?.classList.toggle("hidden", !val.trim());
}
document.getElementById("filter-search")?.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  updateExtratoSearchClear();
  searchTimeout = setTimeout(() => { applyFilters(); updateFilterBadge(); }, 200);
});
document.getElementById("filter-search-clear")?.addEventListener("click", () => {
  const input = document.getElementById("filter-search");
  if (input) { input.value = ""; input.focus(); }
  updateExtratoSearchClear();
  applyFilters();
  updateFilterBadge();
});

// Extrato: auto-filter on change
document.getElementById("filter-status")?.addEventListener("change", () => { applyFilters(); updateFilterBadge(); collapseFilterPanel("extrato-filter-panel", "extrato-filter-toggle"); });
document.getElementById("filter-start-date")?.addEventListener("change", () => { applyFilters(); updateFilterBadge(); });
document.getElementById("filter-end-date")?.addEventListener("change", () => { applyFilters(); updateFilterBadge(); });

// Copy detail value on click (shared handler for all lists with .copyable elements)
function handleCopyableClick(e) {
  const el = e.target.closest(".copyable");
  if (!el) return;
  const text = el.dataset.copy;
  if (text && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      el.classList.add("copied");
      showToast("Copiado!");
      setTimeout(() => el.classList.remove("copied"), 1500);
    });
  }
}
document.getElementById("transactions-list")?.addEventListener("click", handleCopyableClick);
document.getElementById("products-list")?.addEventListener("click", handleCopyableClick);
document.getElementById("api-keys-list")?.addEventListener("click", handleCopyableClick);
document.getElementById("sales-list")?.addEventListener("click", handleCopyableClick);

// Checkout metadata modal
document.getElementById("sales-list")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".checkout-metadata-btn");
  if (!btn) return;
  e.stopPropagation();
  const raw = btn.dataset.metadata;
  if (!raw) return;
  try {
    const obj = JSON.parse(raw);
    document.getElementById("checkout-metadata-content").textContent = JSON.stringify(obj, null, 2);
  } catch {
    document.getElementById("checkout-metadata-content").textContent = raw;
  }
  document.getElementById("checkout-metadata-modal")?.classList.remove("hidden");
});
document.getElementById("close-checkout-metadata")?.addEventListener("click", () => {
  document.getElementById("checkout-metadata-modal")?.classList.add("hidden");
});

// Extrato: clear filters
document.getElementById("extrato-clear-filters")?.addEventListener("click", () => {
  // Reset search
  const searchInput = document.getElementById("filter-search");
  if (searchInput) searchInput.value = "";
  // Reset type
  document.querySelectorAll(".extrato-pill[data-filter-type]").forEach(b => b.classList.remove("active"));
  document.querySelector('.extrato-pill[data-filter-type="all"]')?.classList.add("active");
  // Reset status
  const status = document.getElementById("filter-status");
  if (status) status.value = "";
  // Reset period
  document.querySelectorAll(".extrato-period-btn[data-period]").forEach(b => b.classList.remove("active"));
  document.querySelector('.extrato-period-btn[data-period="all"]')?.classList.add("active");
  document.getElementById("extrato-custom-range")?.classList.add("hidden");
  const startDate = document.getElementById("filter-start-date");
  const endDate = document.getElementById("filter-end-date");
  if (startDate) startDate.value = "";
  if (endDate) endDate.value = "";
  applyFilters();
  updateFilterBadge();
  collapseFilterPanel("extrato-filter-panel", "extrato-filter-toggle");
});

// Extrato: load more (client-side pagination)

// Acompanhe buttons
document.getElementById("btnAcompanhar")?.addEventListener("click", () => {
  if (lastDepositQrId) {
    navigate("#transactions?type=deposit&id=" + lastDepositQrId);
  } else {
    navigate("#transactions");
  }
});

document.getElementById("btnAcompanharSaque")?.addEventListener("click", () => {
  if (lastWithdrawalId) {
    navigate("#transactions?type=withdraw&id=" + lastWithdrawalId);
  } else {
    navigate("#transactions");
  }
});

// =========================================
// ROUTING SETUP
// =========================================

function goToAppropriateScreen() {
  _goToAppropriateScreen({ isLoggedIn, hasAddresses, navigate });
}

route("#home", () => {
  stopTransactionsPolling();
  updateAddrDisplay();
  // Show banners
  const homeUser = getUser();
  document.getElementById("home-verify-banner")?.classList.toggle("hidden", !!homeUser?.verified);
  document.getElementById("deposit-limit-info")?.classList.toggle("hidden", !!homeUser?.verified);
  document.getElementById("home-whatsapp-banner")?.classList.remove("hidden");
  document.getElementById("resultado")?.classList.add("hidden");
  document.getElementById("formDeposito")?.classList.remove("hidden");
  document.getElementById("valor").value = "";
  setMsg("mensagem", "");
  // Reset saque state
  document.getElementById("resultadoSaque")?.classList.add("hidden");
  document.getElementById("formSaque")?.classList.remove("hidden");
  document.getElementById("saqueQr")?.classList.add("hidden");
  document.getElementById("saqueWarningInfo")?.classList.add("hidden");
  document.getElementById("saqueWarningAmount")?.classList.add("hidden");
  // Reset saque toggle to default (DePix mode)
  valorModeIsPix = false;
  document.getElementById("valorModeTrack")?.classList.remove("active");
  const valorModeTextEl = document.getElementById("valorModeText");
  if (valorModeTextEl) valorModeTextEl.innerText = "Valor que você envia";
  const valorSaqueInput = document.getElementById("valorSaque");
  if (valorSaqueInput) { valorSaqueInput.value = ""; valorSaqueInput.placeholder = "0,00 DePix"; }
  // Reset converter state
  const converterContent = document.getElementById("converterContent");
  if (converterContent) converterContent.innerHTML = toTrustedHTML("");
  document.getElementById("converterError")?.classList.add("hidden");
  document.getElementById("converterLoading")?.classList.add("hidden");
  // Fetch BRSwap feature config
  fetchBrswapConfig();
  // Surface the wallet toggle if a wallet exists on this device, and restore
  // the last-selected mode so returning from #wallet-receive etc. lands the
  // user back on Minha Carteira.
  void refreshWalletModeAvailability();
});

async function refreshWalletModeAvailability() {
  const walletBtn = document.getElementById("modeWallet");
  if (!walletBtn) return;
  // Cheap cache of hasWallet() so users without a wallet never pay the
  // ~197kb bundle download just to answer "is there a wallet?". Flag is
  // set by wallet.js on create/restore and cleared on any wipe path; IDB
  // stays the source of truth. See wallet.js:markWalletExists.
  let hasFlag = false;
  try { hasFlag = localStorage.getItem("depix-wallet-exists") === "1"; }
  catch { /* private mode */ }
  if (!hasFlag) {
    // Backfill path: the flag can be missing while IDB still holds a
    // wallet (install pre-dates the flag, localStorage cleared out-of-band,
    // or a dev restart that only wipes localStorage). A raw IDB probe
    // avoids a false negative without loading the bundle.
    const idbHasWallet = await hasWalletInIdbRaw();
    if (!idbHasWallet) {
      walletBtn.classList.add("hidden");
      if (modoWallet) switchMode("deposit");
      return;
    }
    try { localStorage.setItem("depix-wallet-exists", "1"); }
    catch { /* private mode */ }
  }
  // Trust the flag from here on — loading the whole bundle just to re-verify
  // what the flag already tells us would double the IO on every home mount.
  // If the flag turns out to be stale (flag=true but IDB was wiped behind
  // our back), activateWalletHome surfaces the error in #wallet-home-msg
  // when the user actually enters the tab.
  const walletExists = true;
  const walletEnabled = await isWalletFeatureEnabled();
  const plan = planHomeToggle({ walletExists, walletEnabled });
  // Override: when the user has explicitly committed to an external wallet
  // (destination=external), we hide the Minha Carteira tab even though the
  // wallet still lives in IDB. Getting it back is a two-click journey via
  // the menu — which matches the expectation that "Usar Carteira Externa"
  // is a deliberate opt-out.
  const destination = readHomeDestinationChoice();
  const showWalletBtn = plan.showWalletBtn && !(walletExists && destination === "external");
  const shouldForceDeposit = plan.forceDeposit || (!showWalletBtn && modoWallet);
  walletBtn.classList.toggle("hidden", !showWalletBtn);
  // Wallet availability gates the destination selector — refresh after the
  // toggle visibility updates so the tile + chip reflect the new state.
  void refreshHomeDestination();
  if (shouldForceDeposit && modoWallet) {
    switchMode("deposit");
    return;
  }
  if (!plan.allowRestorePreferred) return;
  let preferred = null;
  try {
    preferred = localStorage.getItem("depix-home-mode");
  } catch { /* private mode */ }
  if (preferred === "wallet" && !modoWallet) {
    switchMode("wallet");
  }
}

// Raw IndexedDB existence check — resolves true iff `depix-wallet` has a
// credentials row with a non-empty encryptedSeed. Duplicates a sliver of
// wallet-store.js on purpose so script.js can detect a stranded wallet
// without dynamic-importing the bundle.
function hasWalletInIdbRaw() {
  return new Promise(resolve => {
    if (typeof indexedDB === "undefined") { resolve(false); return; }
    let req;
    try { req = indexedDB.open("depix-wallet"); }
    catch { resolve(false); return; }
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
    req.onupgradeneeded = () => {
      // DB didn't exist (or was on an older version) — fresh install,
      // no wallet to backfill. Abort so we don't accidentally create an
      // empty schema racing with the real wallet-store upgrade path.
      try { req.transaction?.abort(); } catch { /* best effort */ }
      resolve(false);
    };
    req.onsuccess = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("credentials")) {
        db.close();
        resolve(false);
        return;
      }
      let tx;
      try { tx = db.transaction("credentials", "readonly"); }
      catch { db.close(); resolve(false); return; }
      const getReq = tx.objectStore("credentials").get("main");
      getReq.onsuccess = () => {
        const rec = getReq.result;
        const seed = rec?.encryptedSeed;
        const len = seed?.byteLength ?? seed?.length ?? 0;
        db.close();
        resolve(len > 0);
      };
      getReq.onerror = () => { db.close(); resolve(false); };
    };
  });
}

async function isWalletFeatureEnabled() {
  try {
    return await getDefaultConfigClient().isWalletEnabled();
  } catch {
    return true; // fail-open
  }
}

route("#login", () => {
  stopTransactionsPolling();
  if (isLoggedIn()) goToAppropriateScreen();
  // Always clear password field when showing login
  const loginSenha = document.getElementById("login-senha");
  if (loginSenha) loginSenha.value = "";
});

route("#register", () => {
  setMsg("register-msg", "");
  captureReferralCode(window.location.hash);
  renderTurnstile();
});
route("#verify", () => {
  setMsg("verify-msg", "");
  document.getElementById("verify-code").value = "";
  const hasUsuario = !!sessionStorage.getItem("depix-verify-usuario");
  const grupoUsuario = document.getElementById("verify-usuario-group");
  if (grupoUsuario) {
    grupoUsuario.classList.toggle("hidden", hasUsuario);
  }
});
route("#affiliates", () => {
  if (!isLoggedIn()) { navigate("#login"); return; }
  loadAffiliateData();
});
route("#commissions", () => {
  if (!isLoggedIn()) { navigate("#login"); return; }
  loadCommissionsData();
});
route("#reports", () => { navigate("#transactions"); });
route("#no-address", () => {});
route("#faq", () => {});
route("#transactions", () => { loadTransactions(); });
route("#forgot-password", () => { setMsg("forgot-msg", ""); });
route("#reset-password", () => { setMsg("reset-msg", ""); });

route("#landing", () => {
  captureReferralCode(window.location.hash);
});

// ===== Landing page toggle =====
function setupLandingToggle() {
  const merchantBtn = document.getElementById("toggleMerchant");
  const individualBtn = document.getElementById("toggleIndividual");
  if (!merchantBtn || !individualBtn) return;

  function setMode(mode) {
    const isMerchant = mode === "merchant";
    merchantBtn.classList.toggle("active", isMerchant);
    individualBtn.classList.toggle("active", !isMerchant);
    merchantBtn.setAttribute("aria-checked", isMerchant);
    individualBtn.setAttribute("aria-checked", !isMerchant);

    document.querySelectorAll(".landing-merchant-text, .landing-merchant-content").forEach(el => {
      el.classList.toggle("hidden", !isMerchant);
    });
    document.querySelectorAll(".landing-individual-text, .landing-individual-content").forEach(el => {
      el.classList.toggle("hidden", isMerchant);
    });
  }

  merchantBtn.addEventListener("click", () => setMode("merchant"));
  individualBtn.addEventListener("click", () => setMode("individual"));
}
setupLandingToggle();

// ===== Merchant Dashboard =====
let merchantData = null;
let salesPollingInterval = null;
let salesObserver = null;
let salesDisplayedCount = 0;
let filteredSales = [];
let allSalesCheckouts = [];
let currentSalesProductId = null;
let currentSalesProductSlug = "";
const SALES_PAGE_SIZE = 50;
let pendingMerchantAction = null;
let pendingRevokeKeyId = null;
let pendingLiquidPassword = null;

function normalizeWebsite(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return "https://" + url;
}

const CHECKOUT_STATUS_LABELS = {
  pending: "Pendente", processing: "Processando", completed: "Concluído",
  expired: "Expirado", cancelled: "Cancelado"
};

function checkoutStatusColor(status) {
  if (status === "completed") return "status-green";
  if (["pending", "processing"].includes(status)) return "status-yellow";
  if (status === "expired") return "status-gray";
  if (status === "cancelled") return "status-red";
  return "status-gray";
}

const CHECKOUT_NON_TERMINAL = new Set(["pending", "processing"]);

function renderCheckoutItem(c) {
  const statusLabel = CHECKOUT_STATUS_LABELS[c.status] || escapeHtml(c.status);
  const colorClass = checkoutStatusColor(c.status);
  const amount = formatBRL(c.amount);
  const desc = c.description ? `<span class="checkout-desc">${escapeHtml(c.description)}</span>` : '<span class="checkout-desc text-muted">(sem descrição)</span>';
  const productName = c.product_name ? `<span class="checkout-product-name">${escapeHtml(c.product_name)}</span>` : "";
  let paidIn = "";
  if (c.status === "completed" && c.created_at && c.processing_at) {
    const diffMs = new Date(c.processing_at) - new Date(c.created_at);
    const mins = Math.round(diffMs / 60000);
    paidIn = `<span class="transaction-detail"><span class="transaction-detail-label">Pago em:</span> <span class="transaction-detail-value">${mins}min</span></span>`;
  }
  let parsedMeta = null;
  if (c.metadata) {
    try { parsedMeta = typeof c.metadata === "string" ? JSON.parse(c.metadata) : c.metadata; } catch { /* ignore */ }
  }
  const metadataBtn = parsedMeta ? `<button class="checkout-metadata-btn" type="button" data-metadata="${escapeHtml(JSON.stringify(parsedMeta))}">Metadata</button>` : "";
  return `<div class="transaction-item">
    <div class="transaction-info">
      <span class="transaction-amount">${amount}</span>
      <span class="transaction-date">${formatDateShort(c.created_at)}</span>
    </div>
    <span class="transaction-status ${colorClass}">${statusLabel}</span>
    ${desc}
    ${productName}
    <div class="transaction-details">
      ${paidIn}
      ${metadataBtn}
    </div>
  </div>`;
}

function showMerchantMenu() {
  document.getElementById("menu-merchant-section")?.classList.remove("hidden");
}

function stopSalesPolling() {
  if (salesPollingInterval) { clearInterval(salesPollingInterval); salesPollingInterval = null; }
  if (salesObserver) { salesObserver.disconnect(); salesObserver = null; }
}

// === Dispatcher: checks user state and redirects ===
async function loadMerchantDispatcher() {
  const sections = ["merchant-unverified", "merchant-create", "merchant-deactivated"];
  sections.forEach(id => document.getElementById(id)?.classList.add("hidden"));
  document.getElementById("merchant-loading")?.classList.remove("hidden");
  setMsg("merchant-msg", "");

  try {
    // Single API call determines state: 403=not verified, 404=verified no merchant, 200=has merchant
    const merchantRes = await apiFetch("/api/merchants/me");

    if (merchantRes.status === 403) {
      const errBody = await merchantRes.json().catch(() => ({}));
      const errMsg = errBody?.response?.errorMessage || errBody?.errorMessage || "";

      // Deactivated merchant — show deactivation banner
      if (errMsg.includes("desativada")) {
        document.getElementById("merchant-deactivated").classList.remove("hidden");
        return;
      }

      // Not verified — update localStorage and show progress
      const u = getUser();
      if (u && u.verified) { u.verified = 0; localStorage.setItem("depix-user", JSON.stringify(u)); }
      const res = await apiFetch("/api/status?type=deposit");
      if (!res.ok) { setMsg("merchant-msg", "Erro ao carregar progresso."); return; }
      const data = await res.json();
      const completed = (data.transactions || []).filter(tx => tx.status === "depix_sent").length;
      const progress = Math.min(completed, 10);

      if (completed >= 10) {
        // Deposits done but backend hasn't set verified yet — force refresh
        const rt = getRefreshToken();
        if (rt) {
          try {
            const rRes = await apiFetch("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: rt }) });
            if (rRes.ok) {
              const rData = await rRes.json();
              if (rData.token && rData.refreshToken) {
                const updated = getUser();
                if (updated) updated.verified = rData.user?.verified;
                setAuth(rData.token, rData.refreshToken, updated);
                if (getUser()?.verified) { loadMerchantDispatcher(); return; }
              }
            }
          } catch { /* ignore */ }
        }
        document.getElementById("merchant-progress-bar").style.width = "100%";
        document.getElementById("merchant-progress-text").textContent = "10/10 concluídos — verificação em andamento…";
      } else {
        document.getElementById("merchant-progress-bar").style.width = `${progress * 10}%`;
        document.getElementById("merchant-progress-text").textContent = `${progress}/10 depósitos concluídos`;
      }
      document.getElementById("merchant-unverified").classList.remove("hidden");
      return;
    }

    if (merchantRes.status === 404) {
      // Verified but no merchant — update localStorage and show creation form
      const u = getUser();
      if (u && !u.verified) { u.verified = 1; localStorage.setItem("depix-user", JSON.stringify(u)); }
      merchantData = null;
      // Populate dropdown BEFORE showing the form so the user never sees
      // the empty-or-undecided state while listDestinationOptions resolves.
      await merchantAddrDropdown.populate();
      document.getElementById("merchant-create").classList.remove("hidden");
      return;
    }

    if (!merchantRes.ok) {
      const errBody = await merchantRes.json().catch(() => ({}));
      setMsg("merchant-msg", errBody?.errorMessage || "Erro ao carregar dados");
      return;
    }
    const merchant = await merchantRes.json();

    merchantData = merchant.merchant || merchant;
    // Sync verified in localStorage
    const u = getUser();
    if (u && !u.verified) { u.verified = 1; localStorage.setItem("depix-user", JSON.stringify(u)); }
    showMerchantMenu();

    navigate("#merchant-charge");
  } catch (e) {
    if (!e.blocked) setMsg("merchant-msg", e.message || "Erro ao carregar");
  } finally {
    document.getElementById("merchant-loading")?.classList.add("hidden");
  }
}

// === Cobrar ===
async function loadChargeView() {
  showMerchantMenu();

  // Ensure merchantData is loaded
  if (!merchantData) {
    try {
      const res = await apiFetch("/api/merchant");
      if (res.ok) { const d = await res.json(); merchantData = d.merchant || d; }
    } catch { /* ignore */ }
  }

  const username = merchantData?.username;
  const paymentUrl = username ? `https://pay.depixapp.com/${username}` : "";
  const linkEl = document.getElementById("charge-payment-link");
  const linkText = document.getElementById("charge-payment-link-text");
  if (linkEl) linkEl.href = paymentUrl;
  if (linkText) linkText.textContent = paymentUrl;

  // Show share button only if Web Share API is available
  const shareBtn = document.getElementById("btn-charge-share");
  if (shareBtn && navigator.share) shareBtn.classList.remove("hidden");
}

// === Minha Conta ===
async function loadAccountView() {
  showMerchantMenu();
  try {
    const res = await apiFetch("/api/merchants/me");
    if (res.ok) { const d = await res.json(); merchantData = d.merchant || d; }
    const container = document.getElementById("merchant-account-list");
    if (merchantData && container) {
      const mainFields = [
        { label: "Nome", value: merchantData.business_name, field: "business_name" },
        { label: "Endereço Liquid", value: abbreviateAddress(merchantData.liquid_address), field: "liquid_address" },
        { label: "CNPJ", value: merchantData.cnpj, field: "cnpj" },
        { label: "Website", value: merchantData.website, field: "website" },
      ];
      const advancedFields = [
        { label: "Callback URL", value: merchantData.default_callback_url, field: "default_callback_url", infoBtn: "account-callback-info" },
        { label: "Redirect URL", value: merchantData.default_redirect_url, field: "default_redirect_url", infoBtn: "account-redirect-info" },
      ];
      const renderField = f => {
        const hasValue = !!f.value;
        const valueClass = `account-field-value${f.field === "liquid_address" ? " mono" : ""}${hasValue ? "" : " empty"}`;
        const display = hasValue ? escapeHtml(f.value) : "Não informado";
        const infoIcon = f.infoBtn ? ` <button id="${f.infoBtn}" class="icon-btn-sm" aria-label="O que é isso?">?</button>` : "";
        return `<div class="account-field">
          <div class="account-field-label">${f.label}${infoIcon}</div>
          <div class="account-field-value-row">
            <span class="${valueClass}">${display}</span>
            <button class="merchant-edit-btn" data-field="${f.field}">${hasValue ? "Editar" : "Adicionar"}</button>
          </div>
        </div>`;
      };
      const hasLogo = !!merchantData.logo_url;
      const logoFieldHtml = `<div class="account-field">
          <div class="account-field-label">Logo <button class="icon-btn-sm image-tips-btn" aria-label="Dicas para imagem">?</button></div>
          <div class="image-file-row" id="merchant-account-logo-row">
            <input type="file" accept="image/*" class="image-file-input" />
            <div class="image-file-empty${hasLogo ? " hidden" : ""}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              <span>Adicionar logo</span>
            </div>
            <div class="image-file-selected hidden">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              <span class="image-file-name"></span>
              <button type="button" class="image-file-remove" aria-label="Remover imagem">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div class="image-file-existing${hasLogo ? "" : " hidden"}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              <span>Logo atual</span>
              <button type="button" class="image-file-change">Alterar</button>
              <button type="button" class="image-file-remove-existing" aria-label="Remover logo">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div class="image-file-uploading hidden">
              <span class="spinner"></span>
              <span>Enviando...</span>
            </div>
          </div>
        </div>`;
      container.innerHTML = toTrustedHTML('<div class="account-list">'
        + mainFields.map(renderField).join("")
        + logoFieldHtml
        + `<div class="account-advanced-toggle-row"><button id="btn-account-advanced" class="advanced-toggle-btn">Configurações avançadas <span id="account-advanced-arrow" class="advanced-toggle-arrow">▸</span></button></div>`
        + `<div id="account-advanced-fields" class="account-advanced hidden">${advancedFields.map(renderField).join("")}</div>`
        + '</div>');
      // Re-attach edit handlers
      // Advanced toggle
      document.getElementById("btn-account-advanced")?.addEventListener("click", () => {
        const panel = document.getElementById("account-advanced-fields");
        const arrow = document.getElementById("account-advanced-arrow");
        if (panel) {
          const isHidden = panel.classList.toggle("hidden");
          if (arrow) arrow.classList.toggle("open", !isHidden);
        }
      });
      // Info modals for advanced fields
      document.getElementById("account-callback-info")?.addEventListener("click", () => {
        document.getElementById("callback-info-modal")?.classList.remove("hidden");
      });
      document.getElementById("account-redirect-info")?.addEventListener("click", () => {
        document.getElementById("redirect-info-modal")?.classList.remove("hidden");
      });
      container.querySelectorAll(".merchant-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const field = btn.dataset.field;
          const labels = { business_name: "Nome do negócio", liquid_address: "Endereço Liquid", cnpj: "CNPJ", website: "Website", default_callback_url: "Callback URL", default_redirect_url: "Redirect URL" };
          if (field === "liquid_address") {
            pendingMerchantAction = { type: "edit_liquid" };
            document.getElementById("merchant-password-title").textContent = "Confirmar alteração";
            document.getElementById("merchant-password-desc").textContent = "Para alterar o endereço Liquid, confirme sua senha.";
            document.getElementById("merchant-password-input").value = "";
            setMsg("merchant-password-msg", "");
            document.getElementById("merchant-password-modal")?.classList.remove("hidden");
            return;
          }
          document.getElementById("merchant-edit-title").textContent = `Editar ${labels[field] || field}`;
          document.getElementById("merchant-edit-input").value = merchantData?.[field] || "";
          document.getElementById("merchant-edit-input").dataset.field = field;
          setMsg("merchant-edit-modal-msg", "");
          document.getElementById("merchant-edit-modal")?.classList.remove("hidden");
        });
      });
      // Wire up account logo file upload (immediate upload since merchant exists)
      const accountLogoRow = initImageFileRow("merchant-account-logo-row");
      const accountLogoInput = document.querySelector("#merchant-account-logo-row .image-file-input");
      if (accountLogoInput) {
        accountLogoInput.addEventListener("change", async () => {
          const file = accountLogoInput.files?.[0];
          if (!file || !file.type.startsWith("image/")) return;
          accountLogoRow.setUploading();
          try {
            await uploadImage(file, "logo");
            merchantData = null;
            showToast("Logo atualizado!");
            loadAccountView();
          } catch (err) {
            showToast(err.message || "Erro no upload do logo.");
            accountLogoRow.setExisting(!!merchantData?.logo_url);
          }
        });
      }
      const accountLogoRemoveBtn = document.querySelector("#merchant-account-logo-row .image-file-remove-existing");
      if (accountLogoRemoveBtn) {
        accountLogoRemoveBtn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          try {
            await deleteImageApi("logo");
            merchantData = null;
            showToast("Logo removido!");
            loadAccountView();
          } catch (_err) { showToast("Erro ao remover logo."); }
        });
      }
      const accountLogoChangeBtn = document.querySelector("#merchant-account-logo-row .image-file-change");
      if (accountLogoChangeBtn) {
        accountLogoChangeBtn.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          accountLogoInput?.click();
        });
      }
    }
  } catch (e) { if (!e.blocked) showToast("Erro ao carregar conta."); }
}

// === API e Webhooks ===
async function loadApiView() {
  showMerchantMenu();
  try {
    // Fetch merchant data and API keys in parallel
    const [mRes, res] = await Promise.all([
      apiFetch("/api/merchants/me"),
      apiFetch("/api/api-keys"),
    ]);
    if (mRes.ok) { const d = await mRes.json(); merchantData = d.merchant || d; }
    if (merchantData) {
      document.getElementById("merchant-webhook-secret").textContent =
        merchantData.webhook_secret_prefix ? `${merchantData.webhook_secret_prefix}••••••••` : "—";
    }
    if (!res.ok) { showToast("Erro ao carregar chaves."); return; }
    const data = await res.json();
    const keys = data.api_keys || [];
    const list = document.getElementById("api-keys-list");
    const empty = document.getElementById("api-keys-empty");
    if (keys.length === 0) {
      list.innerHTML = toTrustedHTML("");
      empty?.classList.remove("hidden");
    } else {
      empty?.classList.add("hidden");
      list.innerHTML = toTrustedHTML(keys.map(k => {
        const isLive = k.is_live === 1 || k.is_live === true;
        const typeBadge = isLive
          ? '<span class="badge badge-green">Produção</span>'
          : '<span class="badge badge-yellow">Teste</span>';
        const expired = k.expires_at && new Date(k.expires_at) < new Date();
        const expiresText = !k.expires_at ? "sem expiração"
          : expired ? "expirada"
          : `expira em ${Math.ceil((new Date(k.expires_at) - new Date()) / 86400000)}d`;
        const expiresClass = expired ? "text-danger" : "";
        const lastUsed = k.last_used_at ? formatDateShort(k.last_used_at) : "nunca";
        const keyDisplay = k.key_plain || (k.prefix + "••••••");
        const labelText = k.label && k.label !== "Produção" && k.label !== "Teste" ? k.label : null;
        return `<div class="api-key-card">
          <div class="api-key-top-row">${typeBadge}${labelText ? `<span class="api-key-label">${escapeHtml(labelText)}</span>` : ""}<button class="btn-revoke-key" data-key-id="${escapeHtml(k.id)}">Revogar</button></div>
          <div class="api-key-value"><span class="mono">${escapeHtml(keyDisplay)}</span></div>
          <div class="api-key-detail"><span class="${expiresClass}">${expiresText}</span> · usado: ${lastUsed}</div>
        </div>`;
      }).join(""));

      // Expired key alert
      const expiredKey = keys.find(k => k.expires_at && new Date(k.expires_at) < new Date());
      const expAlert = document.getElementById("merchant-alert-expired-key");
      if (expiredKey && expAlert) {
        expAlert.innerHTML = toTrustedHTML(`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Sua chave ${escapeHtml(expiredKey.prefix)}...${expiredKey.label ? " (" + escapeHtml(expiredKey.label) + ")" : ""} expirou. Crie uma nova.`);
        expAlert.classList.remove("hidden");
      } else if (expAlert) {
        expAlert.classList.add("hidden");
      }
    }
  } catch (e) { if (!e.blocked) showToast("Erro ao carregar painel."); }
}

// === Minhas Vendas ===
function buildSalesFilterParams() {
  const params = new URLSearchParams();
  if (currentSalesProductId) params.set("product_id", currentSalesProductId);
  const status = document.getElementById("sales-filter-status")?.value;
  if (status) params.set("status", status);
  const search = document.getElementById("sales-filter-search")?.value.trim();
  if (search) params.set("q", search);
  const activeBtn = document.querySelector("[data-sales-period].active");
  const period = activeBtn?.dataset.salesPeriod || "all";
  if (period !== "all" && period !== "custom") {
    const now = new Date();
    const fmt = d => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    params.set("to", fmt(now));
    if (period === "today") params.set("from", fmt(now));
    else if (period === "7d") params.set("from", fmt(new Date(now.getTime() - 7 * 86400000)));
    else if (period === "30d") params.set("from", fmt(new Date(now.getTime() - 30 * 86400000)));
    else if (period === "90d") params.set("from", fmt(new Date(now.getTime() - 90 * 86400000)));
  } else if (period === "custom") {
    const from = document.getElementById("sales-filter-start")?.value;
    const to = document.getElementById("sales-filter-end")?.value;
    if (from) params.set("from", from);
    if (to) params.set("to", to);
  }
  return params;
}

function syncSalesProductChip() {
  const chip = document.getElementById("sales-product-filter");
  const label = document.getElementById("sales-product-filter-label");
  const dropdown = document.getElementById("sales-filter-product");
  if (currentSalesProductId && chip && label) {
    label.textContent = currentSalesProductSlug || currentSalesProductId;
    chip.classList.remove("hidden");
  } else if (chip) {
    chip.classList.add("hidden");
  }
  if (dropdown) dropdown.value = currentSalesProductId || "";
}

let salesProductsCache = null;
async function populateSalesProductDropdown() {
  const dropdown = document.getElementById("sales-filter-product");
  if (!dropdown) return;
  try {
    // Retry fetch if cache is null or empty (user may have just created a product)
    if (!salesProductsCache || salesProductsCache.length === 0) {
      const res = await apiFetch("/api/products");
      if (res.ok) {
        const data = await res.json();
        salesProductsCache = (data.products || []).filter(p => p.active);
      }
    }
    if (salesProductsCache) {
      // Keep "Todos" option, rebuild the rest
      dropdown.innerHTML = toTrustedHTML('<option value="">Todos</option>');
      for (const p of salesProductsCache) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name || p.description || p.slug;
        dropdown.appendChild(opt);
      }
      if (currentSalesProductId) dropdown.value = currentSalesProductId;
    }
  } catch { /* non-critical — dropdown stays with just "Todos" */ }
}

async function loadSalesView() {
  stopSalesPolling();
  showMerchantMenu();

  // Parse product filter from hash params
  const hashParams = new URLSearchParams(window.location.hash.split("?")[1] || "");
  const hashProductId = hashParams.get("product_id") || null;
  const hashProductSlug = hashParams.get("product") || "";
  // Only override from hash if it carries a product_id (i.e. coming from products screen)
  if (hashProductId) {
    currentSalesProductId = hashProductId;
    currentSalesProductSlug = hashProductSlug;
  }
  syncSalesProductChip();

  // Populate product dropdown (non-blocking)
  populateSalesProductDropdown();

  document.getElementById("sales-loading")?.classList.remove("hidden");
  document.getElementById("sales-empty")?.classList.add("hidden");
  setMsg("sales-msg", "");
  const list = document.getElementById("sales-list");
  list.innerHTML = toTrustedHTML('<div id="sales-sentinel" aria-hidden="true" style="height:1px"></div>');

  try {
    const params = buildSalesFilterParams();
    const res = await apiFetch(`/api/checkouts?${params.toString()}`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); setMsg("sales-msg", e?.errorMessage || "Erro ao carregar vendas."); return; }
    const data = await res.json();

    allSalesCheckouts = data.checkouts || [];
    const stats = data.stats || {};
    document.getElementById("sales-stat-completed").textContent = stats.completed || 0;
    document.getElementById("sales-stat-received").textContent = formatBRL(stats.completed_amount || 0);
    document.getElementById("sales-stat-conversion").textContent = `${stats.total > 0 ? Math.round(stats.completed / stats.total * 100) : 0}%`;
    document.getElementById("sales-stat-pending").textContent = stats.pending || 0;

    applySalesFilters();

    // Auto-refresh polling
    stopSalesPolling();
    if (allSalesCheckouts.some(c => CHECKOUT_NON_TERMINAL.has(c.status))) {
      salesPollingInterval = setInterval(async () => {
        try {
          const p = buildSalesFilterParams();
          const r = await apiFetch(`/api/checkouts?${p.toString()}`);
          if (!r.ok) return;
          const d = await r.json();
          {
            allSalesCheckouts = d.checkouts || [];
            const st = d.stats || {};
            document.getElementById("sales-stat-completed").textContent = st.completed || 0;
            document.getElementById("sales-stat-received").textContent = formatBRL(st.completed_amount || 0);
            document.getElementById("sales-stat-conversion").textContent = `${st.total > 0 ? Math.round(st.completed / st.total * 100) : 0}%`;
            document.getElementById("sales-stat-pending").textContent = st.pending || 0;
            applySalesFilters();
            if (!allSalesCheckouts.some(c => CHECKOUT_NON_TERMINAL.has(c.status))) stopSalesPolling();
          }
        } catch { /* ignore */ }
      }, 30000);
    }
  } catch (e) {
    if (!e.blocked) setMsg("sales-msg", e.message || "Erro ao carregar vendas.");
  } finally {
    document.getElementById("sales-loading")?.classList.add("hidden");
  }
}

function applySalesFilters() {
  const search = (document.getElementById("sales-filter-search")?.value || "").trim().toLowerCase();
  filteredSales = search
    ? allSalesCheckouts.filter(c => {
        const fields = [c.description, c.id, String(c.amount)];
        return fields.some(f => f && f.toLowerCase().includes(search));
      })
    : [...allSalesCheckouts];
  salesDisplayedCount = 0;
  const list = document.getElementById("sales-list");
  list.innerHTML = toTrustedHTML('<div id="sales-sentinel" aria-hidden="true" style="height:1px"></div>');
  renderSalesNextPage();
  setupSalesObserver();
}

function renderSalesNextPage() {
  const empty = document.getElementById("sales-empty");
  const sentinel = document.getElementById("sales-sentinel");
  const batch = filteredSales.slice(salesDisplayedCount, salesDisplayedCount + SALES_PAGE_SIZE);
  if (salesDisplayedCount === 0 && batch.length === 0) { empty?.classList.remove("hidden"); return; }
  empty?.classList.add("hidden");
  const html = batch.map(c => renderCheckoutItem(c)).join("");
  sentinel?.insertAdjacentHTML("beforebegin", toTrustedHTML(html));
  salesDisplayedCount += batch.length;
}

function setupSalesObserver() {
  if (salesObserver) salesObserver.disconnect();
  const list = document.getElementById("sales-list");
  const sentinel = document.getElementById("sales-sentinel");
  if (!list || !sentinel) return;
  salesObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && salesDisplayedCount < filteredSales.length) renderSalesNextPage();
  }, { root: list, rootMargin: "0px 0px 200px 0px" });
  salesObserver.observe(sentinel);
}

// === Webhook Logs ===
async function loadWebhookLogs() {
  showMerchantMenu();
  document.getElementById("webhook-logs-loading")?.classList.remove("hidden");
  document.getElementById("webhook-logs-empty")?.classList.add("hidden");
  setMsg("webhook-logs-msg", "");

  try {
    const res = await apiFetch("/api/webhook-logs");
    if (!res.ok) { const e = await res.json().catch(() => ({})); setMsg("webhook-logs-msg", e?.errorMessage || "Erro ao carregar logs."); return; }
    const data = await res.json();

    const logs = data.logs || [];
    const list = document.getElementById("webhook-logs-list");
    if (logs.length === 0) {
      list.innerHTML = toTrustedHTML("");
      document.getElementById("webhook-logs-empty")?.classList.remove("hidden");
      return;
    }

    list.innerHTML = toTrustedHTML(logs.map(log => {
      const statusClass = log.status_code >= 200 && log.status_code < 300 ? "status-green" : "status-red";
      return `<div class="webhook-log-item">
        <div class="webhook-log-header">
          <span class="webhook-log-event">${escapeHtml(log.event || "")}</span>
          <span class="webhook-log-status ${statusClass}">${escapeHtml(String(log.status_code || "—"))}</span>
          <span class="webhook-log-attempt">${escapeHtml(String(log.attempt || 1))}/3</span>
          <span class="webhook-log-date">${formatDateShort(log.sent_at)}</span>
        </div>
        <div class="webhook-log-url">${escapeHtml(abbreviateHash(log.url || "", 35, 10))}</div>
        <div class="webhook-log-details hidden">
          ${log.request_body ? `<div class="webhook-log-body"><strong>Request:</strong><pre>${escapeHtml(typeof log.request_body === "string" ? log.request_body : JSON.stringify(log.request_body, null, 2))}</pre></div>` : ""}
          ${log.response_body ? `<div class="webhook-log-body"><strong>Response:</strong><pre>${escapeHtml(log.response_body)}</pre></div>` : ""}
          ${log.error ? `<div class="webhook-log-body text-danger"><strong>Erro:</strong> ${escapeHtml(log.error)}</div>` : ""}
        </div>
      </div>`;
    }).join(""));

    list.querySelectorAll(".webhook-log-item").forEach(item => {
      item.querySelector(".webhook-log-header")?.addEventListener("click", () => {
        item.querySelector(".webhook-log-details")?.classList.toggle("hidden");
      });
    });
  } catch (e) {
    if (!e.blocked) setMsg("webhook-logs-msg", e.message || "Erro.");
  } finally {
    document.getElementById("webhook-logs-loading")?.classList.add("hidden");
  }
}

// === Products ===
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function validateSlug(slug) {
  if (!slug || slug.length < 2 || slug.length > 60) return "O slug deve ter entre 2 e 60 caracteres.";
  if (!SLUG_REGEX.test(slug)) return "Slug inválido. Use apenas letras minúsculas, números e hifens.";
  return null;
}

function validateHttpsUrl(url, fieldName) {
  if (!url) return null; // optional
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return `${fieldName} deve usar HTTPS.`;
  } catch {
    return `${fieldName} inválido.`;
  }
  return null;
}

function getProductIdFromHash() {
  const hash = window.location.hash;
  const params = new URLSearchParams(hash.split("?")[1] || "");
  return params.get("id") || "";
}

async function loadProductsView() {
  showMerchantMenu();
  document.getElementById("products-loading")?.classList.remove("hidden");
  document.getElementById("products-empty")?.classList.add("hidden");
  setMsg("products-msg", "");
  const list = document.getElementById("products-list");
  if (list) list.innerHTML = toTrustedHTML("");

  try {
    const res = await apiFetch("/api/products");
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setMsg("products-msg", e?.errorMessage || "Erro ao carregar produtos.");
      return;
    }
    const data = await res.json();
    const products = data.products || [];

    // Stats
    const totalCount = products.length;
    const activeCount = products.filter(p => p.active).length;
    const totalCheckouts = products.reduce((sum, p) => sum + (p.total_checkouts || 0), 0);
    document.getElementById("products-stat-total").textContent = totalCount;
    document.getElementById("products-stat-active").textContent = activeCount;
    document.getElementById("products-stat-checkouts").textContent = totalCheckouts;

    if (products.length === 0) {
      document.getElementById("products-empty")?.classList.remove("hidden");
      return;
    }

    list.innerHTML = toTrustedHTML(products.map(p => {
      const statusBadge = p.active
        ? '<span class="badge badge-green">Ativo</span>'
        : '<span class="badge badge-gray">Inativo</span>';
      const amount = formatBRL(p.amount);
      const desc = p.description
        ? `<span class="product-card-desc">${escapeHtml(p.description)}</span>`
        : '';
      const checkoutCount = p.total_checkouts || 0;
      const copyIcon = '<svg class="copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      const productUrl = p.slug && merchantData?.username ? `https://pay.depixapp.com/${merchantData.username}/${p.slug}` : "";
      const urlRow = productUrl ? `<div class="product-card-url copyable" data-copy="${escapeHtml(productUrl)}"><span class="product-card-url-text mono">${escapeHtml(productUrl)}</span><span class="product-card-url-copy">${copyIcon}Copiar</span></div>` : "";
      const displayName = p.name || p.slug;
      return `<div class="product-card">
        <div class="product-card-header">
          <div class="product-card-name">${escapeHtml(displayName)}</div>
          ${statusBadge}
        </div>
        <div class="product-card-amount">${amount}</div>
        ${desc}
        ${urlRow}
        <div class="product-card-footer">
          <span class="product-card-checkouts">${checkoutCount} checkout${checkoutCount !== 1 ? 's' : ''}</span>
          <div class="product-card-actions">
            <button class="merchant-text-btn btn-product-checkouts" data-product-id="${escapeHtml(p.id)}" data-product-slug="${escapeHtml(p.slug)}">Checkouts</button>
            <button class="merchant-text-btn btn-product-edit" data-product-id="${escapeHtml(p.id)}">Editar</button>
          </div>
        </div>
      </div>`;
    }).join(""));

    // Attach edit/checkout handlers
    list.querySelectorAll(".btn-product-edit").forEach(btn => {
      btn.addEventListener("click", () => navigate(`#merchant-product-edit?id=${btn.dataset.productId}`));
    });
    list.querySelectorAll(".btn-product-checkouts").forEach(btn => {
      btn.addEventListener("click", () => navigate(`#merchant-sales?product_id=${btn.dataset.productId}&product=${encodeURIComponent(btn.dataset.productSlug)}`));
    });
  } catch (e) {
    if (!e.blocked) setMsg("products-msg", e.message || "Erro ao carregar produtos.");
  } finally {
    document.getElementById("products-loading")?.classList.add("hidden");
  }
}

async function loadProductCreateView() {
  showMerchantMenu();
  // Reset form
  document.getElementById("product-create-name").value = "";
  document.getElementById("product-create-slug").value = "";
  document.getElementById("product-create-amount").value = "";
  document.getElementById("product-create-description").value = "";
  productCreateImageRow.reset();
  document.getElementById("product-create-callback-url").value = "";
  document.getElementById("product-create-redirect-url").value = "";
  document.getElementById("product-create-expires").value = "";
  document.getElementById("product-create-metadata").value = "";
  setMsg("product-create-msg", "");
  // Collapse advanced section
  const createAdvPanel = document.querySelector('[data-advanced="product-create"]');
  const createAdvArrow = document.getElementById("btn-product-create-advanced")?.querySelector(".advanced-toggle-arrow");
  if (createAdvPanel) createAdvPanel.classList.add("hidden");
  if (createAdvArrow) createAdvArrow.classList.remove("open");
  wireProductNameToSlug("product-create", { slugAlreadySet: false });
}

async function loadProductEditView() {
  showMerchantMenu();
  const productId = getProductIdFromHash();
  if (!productId) { navigate("#merchant-products"); return; }

  setMsg("product-edit-msg", "");

  try {
    const res = await apiFetch(`/api/products/${productId}`);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setMsg("product-edit-msg", e?.errorMessage || "Erro ao carregar produto.");
      return;
    }
    const data = await res.json();
    const product = data.product || data;

    document.getElementById("product-edit-name").value = product.name || product.slug || "";
    document.getElementById("product-edit-slug").value = product.slug || "";
    document.getElementById("product-edit-amount").value = product.amount ? formatBRL(product.amount) : "";
    document.getElementById("product-edit-description").value = product.description || "";
    productEditImageRow.setExisting(!!product.image_url);
    document.getElementById("product-edit-callback-url").value = product.callback_url || "";
    document.getElementById("product-edit-redirect-url").value = product.redirect_url || "";
    document.getElementById("product-edit-expires").value = product.expires_in ? String(product.expires_in) : "";
    document.getElementById("product-edit-metadata").value = product.metadata ? JSON.stringify(product.metadata, null, 2) : "";

    // Always start collapsed
    const advPanel = document.querySelector('[data-advanced="product-edit"]');
    const advArrow = document.getElementById("btn-product-edit-advanced")?.querySelector(".advanced-toggle-arrow");
    if (advPanel) advPanel.classList.add("hidden");
    if (advArrow) advArrow.classList.remove("open");

    // Toggle button label
    const toggleBtn = document.getElementById("btn-product-edit-toggle");
    if (toggleBtn) {
      toggleBtn.textContent = product.active ? "Desativar" : "Ativar";
      toggleBtn.classList.toggle("activate", !product.active);
      toggleBtn.dataset.productId = productId;
      toggleBtn.dataset.isActive = product.active ? "1" : "0";
    }

    // Save button
    const saveBtn = document.getElementById("btn-product-edit-save");
    if (saveBtn) saveBtn.dataset.productId = productId;

    wireProductNameToSlug("product-edit", { slugAlreadySet: true });

  } catch (e) {
    if (!e.blocked) setMsg("product-edit-msg", e.message || "Erro ao carregar produto.");
  }
}

// Wire auto-slug + URL preview for a product form. Called each time the view
// loads so listeners reattach against the fresh form state. Re-binding is safe
// because we clone the inputs to strip any previous listeners.
function wireProductNameToSlug(prefix, { slugAlreadySet }) {
  const nameEl = document.getElementById(`${prefix}-name`);
  const slugEl = document.getElementById(`${prefix}-slug`);
  const previewEl = document.getElementById(`${prefix}-url-preview`);
  if (!nameEl || !slugEl) return;

  // Clone-and-replace clears any prior listeners from earlier view loads
  const freshName = nameEl.cloneNode(true);
  nameEl.parentNode.replaceChild(freshName, nameEl);
  const freshSlug = slugEl.cloneNode(true);
  slugEl.parentNode.replaceChild(freshSlug, slugEl);

  let slugEdited = slugAlreadySet;
  const updatePreview = () => {
    if (!previewEl) return;
    const user = merchantData?.username || "seuusuario";
    const s = freshSlug.value || "...";
    previewEl.textContent = `pay.depixapp.com/${user}/${s}`;
  };
  freshSlug.addEventListener("input", () => { slugEdited = true; updatePreview(); });
  freshName.addEventListener("input", () => {
    if (!slugEdited) freshSlug.value = slugify(freshName.value);
    updatePreview();
  });
  updatePreview();
}


// Routes
// Guard: only allow merchant sub-views if user has active merchant (checks via API)
async function merchantGuard(loadFn) {
  if (!isLoggedIn()) { navigate("#login"); return; }
  const user = getUser();
  if (!user?.verified) { navigate("#merchant"); return; }
  if (!merchantData) {
    try {
      const res = await apiFetch("/api/merchants/me");
      if (!res.ok) { navigate("#merchant"); return; }
      { const d = await res.json(); merchantData = d.merchant || d; }
    } catch { navigate("#merchant"); return; }
  }
  loadFn();
}

route("#verify-account", async () => {
  if (!isLoggedIn()) { navigate("#login"); return; }
  try {
    const res = await apiFetch("/api/status?type=deposit");
    if (!res.ok) return;
    const data = await res.json();
    const completed = (data.transactions || []).filter(tx => tx.status === "depix_sent").length;
    const progress = Math.min(completed, 10);
    document.getElementById("verify-page-progress-bar").style.width = `${progress * 10}%`;
    document.getElementById("verify-page-progress-text").textContent = `${progress}/10 depósitos concluídos`;
  } catch { /* ignore */ }
});
route("#merchant", () => { if (!isLoggedIn()) { navigate("#login"); return; } stopSalesPolling(); loadMerchantDispatcher(); });
route("#merchant-charge", () => { stopSalesPolling(); merchantGuard(loadChargeView); });
route("#merchant-sales", () => { stopSalesPolling(); merchantGuard(loadSalesView); });
route("#merchant-account", () => { stopSalesPolling(); merchantGuard(loadAccountView); });
route("#merchant-api", () => { stopSalesPolling(); merchantGuard(loadApiView); });
route("#merchant-products", () => { stopSalesPolling(); merchantGuard(loadProductsView); });
route("#merchant-product-create", () => { stopSalesPolling(); merchantGuard(loadProductCreateView); });
route("#merchant-product-edit", () => { stopSalesPolling(); merchantGuard(loadProductEditView); });
route("#webhook-logs", () => { stopSalesPolling(); merchantGuard(loadWebhookLogs); });

// Menu accordion — click section title to expand/collapse, only one open at a time
document.querySelectorAll(".menu-section-toggle").forEach(toggle => {
  toggle.addEventListener("click", () => {
    const items = toggle.nextElementSibling;
    const isOpen = !items.classList.contains("hidden");
    // Close all sections
    document.querySelectorAll(".menu-section-items").forEach(s => s.classList.add("hidden"));
    document.querySelectorAll(".menu-section-toggle").forEach(t => t.classList.remove("open"));
    // Open clicked section (if it was closed)
    if (!isOpen) {
      items.classList.remove("hidden");
      toggle.classList.add("open");
    }
  });
});

// Menu handlers
document.getElementById("menu-merchant-charge")?.addEventListener("click", () => { closeMenu(); navigate("#merchant-charge"); });
document.getElementById("menu-merchant-sales")?.addEventListener("click", () => { closeMenu(); navigate("#merchant-sales"); });
document.getElementById("menu-merchant-products")?.addEventListener("click", () => { closeMenu(); navigate("#merchant-products"); });
document.getElementById("menu-merchant-account")?.addEventListener("click", () => { closeMenu(); navigate("#merchant-account"); });
document.getElementById("menu-merchant-api")?.addEventListener("click", () => { closeMenu(); navigate("#merchant-api"); });

// Charge view — copy, download QR, share
document.getElementById("btn-charge-copy")?.addEventListener("click", () => {
  const link = document.getElementById("charge-payment-link")?.href;
  if (link) { navigator.clipboard.writeText(link).then(() => showToast("Link copiado!")).catch(() => showToast("Erro ao copiar")); }
});
document.getElementById("btn-charge-download")?.addEventListener("click", async () => {
  const link = document.getElementById("charge-payment-link")?.href;
  if (!link) return;
  try {
    const dataUrl = await renderPrintableQr(link);
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "depix-qrcode.png";
    a.click();
  } catch { /* generation failed */ }
});
document.getElementById("btn-charge-share")?.addEventListener("click", async () => {
  const link = document.getElementById("charge-payment-link")?.href;
  if (!link || !navigator.share) return;
  try {
    await navigator.share({ title: "Meu link de pagamento — DePix", url: link });
  } catch { /* user cancelled or not supported */ }
});

// Copy key buttons (delegated)
document.addEventListener("click", (e) => {
  const copyBtn = e.target.closest(".btn-copy-key");
  if (!copyBtn) return;
  const input = document.getElementById(copyBtn.dataset.target);
  if (input?.value) { navigator.clipboard.writeText(input.value).then(() => showToast("Copiado!")).catch(() => showToast("Erro ao copiar")); }
});

// Modal close handlers
["close-create-api-key", "close-api-key-created", "close-revoke-api-key",
 "close-merchant-password", "close-webhook-secret", "close-merchant-edit",
 "close-callback-info", "close-redirect-info", "close-metadata-info",
 "close-image-tips", "close-expiration-info", "close-api-key-expires-info",
 "close-slug-info"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", () => {
    document.getElementById(id)?.closest(".modal")?.classList.add("hidden");
  });
});
document.getElementById("btn-welcome-continue")?.addEventListener("click", () => {
  document.getElementById("merchant-welcome-modal")?.classList.add("hidden");
});

// API key: open create modal
document.getElementById("btn-create-api-key")?.addEventListener("click", () => {
  document.getElementById("api-key-type").value = "live";
  document.getElementById("api-key-label").value = "";
  document.getElementById("api-key-expires").value = "";
  setMsg("create-api-key-msg", "");
  document.getElementById("create-api-key-modal")?.classList.remove("hidden");
});

// API key: confirm create
document.getElementById("btn-confirm-create-api-key")?.addEventListener("click", async () => {
  const type = document.getElementById("api-key-type").value;
  const label = document.getElementById("api-key-label")?.value.trim();
  const expires = document.getElementById("api-key-expires")?.value;
  const btn = document.getElementById("btn-confirm-create-api-key");
  btn.disabled = true; btn.textContent = "Criando..."; setMsg("create-api-key-msg", "");
  try {
    const body = { type };
    if (label) body.label = label;
    if (expires) body.expires_in_days = parseInt(expires, 10);
    const res = await apiFetch("/api/api-keys", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("create-api-key-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao criar chave."); return; }
    document.getElementById("create-api-key-modal")?.classList.add("hidden");
    document.getElementById("new-api-key-value").value = data.key || "";
    document.getElementById("api-key-created-modal")?.classList.remove("hidden");
    loadApiView();
  } catch (e) { setMsg("create-api-key-msg", e.message || "Erro."); }
  finally { btn.disabled = false; btn.textContent = "Criar"; }
});

// API key: revoke
document.getElementById("api-keys-list")?.addEventListener("click", (e) => {
  const revokeBtn = e.target.closest(".btn-revoke-key");
  if (!revokeBtn) return;
  pendingRevokeKeyId = revokeBtn.dataset.keyId;
  setMsg("revoke-api-key-msg", "");
  document.getElementById("revoke-api-key-modal")?.classList.remove("hidden");
});
document.getElementById("btn-confirm-revoke")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-confirm-revoke");
  btn.disabled = true; btn.textContent = "Revogando..."; setMsg("revoke-api-key-msg", "");
  try {
    const res = await apiFetch("/api/api-keys/revoke", { method: "POST", body: JSON.stringify({ key_id: pendingRevokeKeyId }) });
    const data = await res.json();
    if (!res.ok) { setMsg("revoke-api-key-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao revogar."); return; }
    document.getElementById("revoke-api-key-modal")?.classList.add("hidden");
    showToast("Chave revogada");
    loadApiView();
  } catch (e) { setMsg("revoke-api-key-msg", e.message || "Erro."); }
  finally { btn.disabled = false; btn.textContent = "Revogar"; pendingRevokeKeyId = null; }
});

// Rotate webhook secret
document.getElementById("btn-rotate-webhook")?.addEventListener("click", () => {
  pendingMerchantAction = { type: "rotate_webhook" };
  document.getElementById("merchant-password-title").textContent = "Rotacionar webhook secret";
  document.getElementById("merchant-password-desc").textContent = "Confirme sua senha para gerar um novo secret.";
  document.getElementById("merchant-password-input").value = "";
  setMsg("merchant-password-msg", "");
  document.getElementById("merchant-password-modal")?.classList.remove("hidden");
});

// Save edit (simple fields)
document.getElementById("btn-merchant-edit-save")?.addEventListener("click", async () => {
  const input = document.getElementById("merchant-edit-input");
  const field = input.dataset.field;
  const value = input.value.trim();
  const btn = document.getElementById("btn-merchant-edit-save");
  btn.disabled = true; btn.textContent = "Salvando..."; setMsg("merchant-edit-modal-msg", "");
  if (field === "cnpj" && value) {
    const cnpjResult = validateCNPJ(value);
    if (!cnpjResult.valid) { setMsg("merchant-edit-modal-msg", cnpjResult.error); btn.disabled = false; btn.textContent = "Salvar"; return; }
  }
  if ((field === "default_callback_url" || field === "default_redirect_url") && value) {
    const urlError = validateHttpsUrl(value, field.replace(/_url$/, " URL").replace(/_/g, " "));
    if (urlError) { setMsg("merchant-edit-modal-msg", urlError); btn.disabled = false; btn.textContent = "Salvar"; return; }
  }
  try {
    let sendValue = value || null;
    if (field === "website" && value) sendValue = normalizeWebsite(value);
    const body = { [field]: sendValue };
    const res = await apiFetch("/api/merchants/me", { method: "PATCH", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("merchant-edit-modal-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao salvar."); return; }
    document.getElementById("merchant-edit-modal")?.classList.add("hidden");
    merchantData = null; // Force reload
    showToast("Dados atualizados");
    loadAccountView();
  } catch (e) { setMsg("merchant-edit-modal-msg", e.message || "Erro ao salvar."); }
  finally { btn.disabled = false; btn.textContent = "Salvar"; }
});

// =====================================================================
// Liquid address edit — wallet/external dropdown + Configure-first gate.
// Replaces the generic merchant-edit-modal text input for this field, so
// the user can only pick from configured destinations (matches the
// merchant-create flow). Password confirmation still gates the save.
// Dropdown wiring lives in `merchantLiquidEditDropdown` (setupDestinationDropdown).
// =====================================================================
document.getElementById("btn-merchant-liquid-edit-cancel")?.addEventListener("click", () => {
  document.getElementById("merchant-liquid-edit-modal")?.classList.add("hidden");
  pendingLiquidPassword = null;
});

document.getElementById("btn-merchant-liquid-edit-save")?.addEventListener("click", async () => {
  const source = merchantLiquidEditDropdown.getSource();
  const btn = document.getElementById("btn-merchant-liquid-edit-save");
  setMsg("merchant-liquid-edit-msg", "");
  if (!source) { setMsg("merchant-liquid-edit-msg", "Configure sua carteira primeiro."); return; }
  if (!pendingLiquidPassword) { setMsg("merchant-liquid-edit-msg", "Confirme sua senha novamente."); return; }
  const { addr, error } = await resolveDestinationAddress(source);
  if (error === "wallet-resolve-failed") {
    showWalletErrorModal({
      onSwitchToExternal: () => merchantLiquidEditDropdown.selectOption("external"),
    });
    return;
  }
  if (!addr) { setMsg("merchant-liquid-edit-msg", "Configure sua carteira primeiro."); return; }
  const v = validateLiquidAddress(addr);
  if (!v.valid) { setMsg("merchant-liquid-edit-msg", v.error); return; }

  btn.disabled = true; btn.textContent = "Salvando...";
  try {
    const res = await apiFetch("/api/merchants/me", {
      method: "PATCH",
      body: JSON.stringify({ liquid_address: addr, password: pendingLiquidPassword })
    });
    const data = await res.json();
    if (!res.ok) {
      setMsg("merchant-liquid-edit-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao salvar.");
      return;
    }
    pendingLiquidPassword = null;
    document.getElementById("merchant-liquid-edit-modal")?.classList.add("hidden");
    merchantData = null;
    showToast("Endereço Liquid atualizado");
    loadAccountView();
  } catch (e) {
    setMsg("merchant-liquid-edit-msg", e.message || "Erro ao salvar.");
  } finally { btn.disabled = false; btn.textContent = "Salvar"; }
});

// Password confirmation (for liquid_address edit or webhook rotation)
document.getElementById("btn-merchant-password-confirm")?.addEventListener("click", async () => {
  const password = document.getElementById("merchant-password-input")?.value;
  const btn = document.getElementById("btn-merchant-password-confirm");
  if (!password) { setMsg("merchant-password-msg", "Informe sua senha."); return; }
  btn.disabled = true; btn.textContent = "Verificando..."; setMsg("merchant-password-msg", "");
  try {
    if (pendingMerchantAction?.type === "edit_liquid") {
      document.getElementById("merchant-password-modal")?.classList.add("hidden");
      pendingLiquidPassword = password;
      setMsg("merchant-liquid-edit-msg", "");
      await merchantLiquidEditDropdown.populate();
      document.getElementById("merchant-liquid-edit-modal")?.classList.remove("hidden");
    } else if (pendingMerchantAction?.type === "rotate_webhook") {
      const res = await apiFetch("/api/merchants/me/rotate-webhook-secret", {
        method: "POST", body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) { setMsg("merchant-password-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao rotacionar."); return; }
      document.getElementById("merchant-password-modal")?.classList.add("hidden");
      document.getElementById("new-webhook-secret-value").value = data.webhook_secret || "";
      document.getElementById("webhook-secret-modal")?.classList.remove("hidden");
      merchantData = null;
      loadApiView();
    }
  } catch (e) { setMsg("merchant-password-msg", e.message || "Erro."); }
  finally { btn.disabled = false; btn.textContent = "Confirmar"; pendingMerchantAction = null; }
});

// Merchant create — dropdown wiring lives in `merchantAddrDropdown`
// (setupDestinationDropdown). When the user has neither wallet nor an
// external address selected, the dropdown is hidden, the "Configure sua
// carteira primeiro" empty-state message shows, and the create button is
// disabled. Selected `data-source` ("wallet" | "external") drives address
// resolution at submit time.

// Create merchant
document.getElementById("btn-create-merchant")?.addEventListener("click", async () => {
  const name = document.getElementById("merchant-name")?.value.trim();
  const cnpj = document.getElementById("merchant-cnpj")?.value.trim();
  const website = document.getElementById("merchant-website")?.value.trim();
  const btn = document.getElementById("btn-create-merchant");
  const source = merchantAddrDropdown.getSource();
  setMsg("merchant-create-msg", "");
  if (!name) { setMsg("merchant-create-msg", "Informe o nome do negócio."); return; }
  if (!source) { setMsg("merchant-create-msg", "Configure sua carteira primeiro."); return; }
  if (cnpj) { const cnpjResult = validateCNPJ(cnpj); if (!cnpjResult.valid) { setMsg("merchant-create-msg", cnpjResult.error); return; } }

  // Resolve the destination address now (deferred from dropdown render so we
  // never load the wallet bundle just to populate the list).
  const { addr, error } = await resolveDestinationAddress(source);
  if (error === "wallet-resolve-failed") {
    showWalletErrorModal({
      onSwitchToExternal: () => merchantAddrDropdown.selectOption("external"),
    });
    return;
  }
  if (!addr) { setMsg("merchant-create-msg", "Configure sua carteira primeiro."); return; }
  const addrValid = validateLiquidAddress(addr);
  if (!addrValid.valid) { setMsg("merchant-create-msg", addrValid.error); return; }

  btn.disabled = true; btn.textContent = "Criando...";
  try {
    const body = { business_name: name, liquid_address: addr };
    if (cnpj) body.cnpj = cnpj;
    if (website) body.website = normalizeWebsite(website);
    const res = await apiFetch("/api/merchants", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 403) {
        // localStorage was stale — update verified and redirect to progress screen
        const u = getUser();
        if (u) { u.verified = 0; localStorage.setItem("depix-user", JSON.stringify(u)); }
        merchantData = null;
        navigate("#merchant");
        return;
      }
      else if (res.status === 409) setMsg("merchant-create-msg", "Você já possui uma conta de lojista.");
      else setMsg("merchant-create-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao criar conta.");
      return;
    }
    // Upload logo if file was selected
    const logoFile = merchantCreateLogoRow.getFile();
    if (logoFile) {
      try { await uploadImage(logoFile, "logo"); }
      catch (_uploadErr) { showToast("Conta criada, mas falha no upload do logo."); }
    }

    merchantData = null;
    showToast("Conta de lojista criada!");
    loadMerchantDispatcher();
  } catch (e) {
    if (!e.blocked) setMsg("merchant-create-msg", e.message || "Erro ao criar conta.");
  } finally { btn.disabled = false; btn.textContent = "Começar"; }
});

// Sales: update filter badge count and clear button visibility
function updateSalesFilterBadge() {
  const status = document.getElementById("sales-filter-status")?.value || "";
  const search = (document.getElementById("sales-filter-search")?.value || "").trim();
  const period = document.querySelector("[data-sales-period].active")?.dataset.salesPeriod || "all";
  const count = (status ? 1 : 0) + (search ? 1 : 0) + (period !== "all" ? 1 : 0) + (currentSalesProductId ? 1 : 0);
  const badge = document.getElementById("sales-filter-badge");
  const toggle = document.getElementById("sales-filter-toggle");
  const clearBtn = document.getElementById("sales-clear-filters");
  if (badge) { badge.textContent = count; badge.classList.toggle("hidden", count === 0); }
  if (toggle) toggle.classList.toggle("active", count > 0);
  if (clearBtn) clearBtn.classList.toggle("hidden", count === 0);
}
function updateSalesSearchClear() {
  const val = document.getElementById("sales-filter-search")?.value || "";
  document.getElementById("sales-search-clear")?.classList.toggle("hidden", !val.trim());
}

// Sales filter toggle
document.getElementById("sales-filter-toggle")?.addEventListener("click", () => {
  const panel = document.getElementById("sales-filter-panel");
  const toggle = document.getElementById("sales-filter-toggle");
  const willOpen = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !willOpen);
  toggle.classList.toggle("open", willOpen);
  // Refresh product dropdown when opening — handles case where user just created a product
  if (willOpen) populateSalesProductDropdown();
});
// Sales status filter
document.getElementById("sales-filter-status")?.addEventListener("change", () => { loadSalesView(); updateSalesFilterBadge(); collapseFilterPanel("sales-filter-panel", "sales-filter-toggle"); });
// Sales product filter dropdown
document.getElementById("sales-filter-product")?.addEventListener("change", (e) => {
  const sel = e.target;
  const selectedOpt = sel.options[sel.selectedIndex];
  currentSalesProductId = sel.value || null;
  currentSalesProductSlug = sel.value ? selectedOpt.textContent : "";
  syncSalesProductChip();
  loadSalesView();
  updateSalesFilterBadge();
  collapseFilterPanel("sales-filter-panel", "sales-filter-toggle");
});
// Sales period presets
document.querySelectorAll("[data-sales-period]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-sales-period]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("sales-custom-range")?.classList.toggle("hidden", btn.dataset.salesPeriod !== "custom");
    if (btn.dataset.salesPeriod !== "custom") {
      loadSalesView();
      collapseFilterPanel("sales-filter-panel", "sales-filter-toggle");
    }
    updateSalesFilterBadge();
  });
});
// Sales custom date range
document.getElementById("sales-filter-start")?.addEventListener("change", () => { loadSalesView(); updateSalesFilterBadge(); });
document.getElementById("sales-filter-end")?.addEventListener("change", () => { loadSalesView(); updateSalesFilterBadge(); });
// Sales search (debounced)
let salesSearchTimer;
document.getElementById("sales-filter-search")?.addEventListener("input", () => {
  clearTimeout(salesSearchTimer);
  updateSalesSearchClear();
  salesSearchTimer = setTimeout(() => { applySalesFilters(); updateSalesFilterBadge(); }, 200);
});
document.getElementById("sales-search-clear")?.addEventListener("click", () => {
  const input = document.getElementById("sales-filter-search");
  if (input) { input.value = ""; input.focus(); }
  updateSalesSearchClear();
  applySalesFilters();
  updateSalesFilterBadge();
});
// Sales clear filters
document.getElementById("sales-clear-filters")?.addEventListener("click", () => {
  document.getElementById("sales-filter-status").value = "";
  document.getElementById("sales-filter-search").value = "";
  const productDropdown = document.getElementById("sales-filter-product");
  if (productDropdown) productDropdown.value = "";
  document.querySelectorAll("[data-sales-period]").forEach(b => b.classList.remove("active"));
  document.querySelector("[data-sales-period='all']")?.classList.add("active");
  document.getElementById("sales-custom-range")?.classList.add("hidden");
  updateSalesSearchClear();
  collapseFilterPanel("sales-filter-panel", "sales-filter-toggle");
  if (currentSalesProductId) {
    currentSalesProductId = null;
    currentSalesProductSlug = "";
    document.getElementById("sales-product-filter")?.classList.add("hidden");
    window.location.hash = "#merchant-sales";
    return; // navigate triggers loadSalesView
  }
  loadSalesView();
  updateSalesFilterBadge();
});
// Sales product filter chip — clear
document.getElementById("sales-product-filter-clear")?.addEventListener("click", () => {
  currentSalesProductId = null;
  currentSalesProductSlug = "";
  syncSalesProductChip();
  navigate("#merchant-sales");
});
// Sales empty CTA
document.getElementById("btn-sales-goto-create")?.addEventListener("click", () => navigate("#merchant-charge"));

// Products — navigate to create
document.getElementById("btn-new-product")?.addEventListener("click", () => navigate("#merchant-product-create"));
document.getElementById("btn-products-goto-create")?.addEventListener("click", () => navigate("#merchant-product-create"));

// Products — advanced toggle (delegated for both create and edit)
["btn-product-create-advanced", "btn-product-edit-advanced"].forEach(id => {
  document.getElementById(id)?.addEventListener("click", () => {
    const btn = document.getElementById(id);
    const panel = btn?.closest(".card")?.querySelector(".product-advanced");
    const arrow = btn?.querySelector(".advanced-toggle-arrow");
    if (panel) {
      const isHidden = panel.classList.toggle("hidden");
      if (arrow) arrow.classList.toggle("open", !isHidden);
    }
  });
});

// Products — info modals (delegated, shared between create and edit)
document.addEventListener("click", (e) => {
  if (e.target.closest(".product-callback-info")) {
    document.getElementById("callback-info-modal")?.classList.remove("hidden");
  } else if (e.target.closest(".product-redirect-info")) {
    document.getElementById("redirect-info-modal")?.classList.remove("hidden");
  } else if (e.target.closest(".product-metadata-info")) {
    document.getElementById("metadata-info-modal")?.classList.remove("hidden");
  } else if (e.target.closest(".image-tips-btn")) {
    document.getElementById("image-tips-modal")?.classList.remove("hidden");
  } else if (e.target.closest(".product-expires-info")) {
    document.getElementById("expiration-info-modal")?.classList.remove("hidden");
  } else if (e.target.closest(".api-key-expires-info")) {
    document.getElementById("api-key-expires-info-modal")?.classList.remove("hidden");
  } else if (e.target.closest(".product-slug-info")) {
    document.getElementById("slug-info-modal")?.classList.remove("hidden");
  }
});

// Products — create submit
document.getElementById("btn-product-create-submit")?.addEventListener("click", async () => {
  const name = document.getElementById("product-create-name")?.value.trim();
  let slug = document.getElementById("product-create-slug")?.value.trim();
  const amountInput = document.getElementById("product-create-amount");
  const description = document.getElementById("product-create-description")?.value.trim();
  const imageFile = productCreateImageRow.getFile();
  const callbackUrl = document.getElementById("product-create-callback-url")?.value.trim();
  const redirectUrl = document.getElementById("product-create-redirect-url")?.value.trim();
  const expiresIn = document.getElementById("product-create-expires")?.value;
  const metadataStr = document.getElementById("product-create-metadata")?.value.trim();
  const btn = document.getElementById("btn-product-create-submit");
  setMsg("product-create-msg", "");

  // Validation
  if (!name || name.length < 2) { setMsg("product-create-msg", "Informe um Nome com pelo menos 2 caracteres."); return; }
  if (name.length > 80) { setMsg("product-create-msg", "Nome deve ter no máximo 80 caracteres."); return; }
  if (!slug) slug = slugify(name);
  const slugErr = validateSlug(slug);
  if (slugErr) { setMsg("product-create-msg", "Não foi possível gerar uma URL a partir do Nome. Ajuste o Nome ou edite o slug em Configurações avançadas."); return; }
  const cents = toCents(amountInput?.value || "");
  if (!cents || cents < 500) { setMsg("product-create-msg", `Valor mínimo: ${formatBRL(500)}`); return; }
  if (cents > 300000) { setMsg("product-create-msg", `Valor máximo: ${formatBRL(300000)}`); return; }
  const cbErr = validateHttpsUrl(callbackUrl, "Callback URL");
  if (cbErr) { setMsg("product-create-msg", cbErr); return; }
  const rdErr = validateHttpsUrl(redirectUrl, "Redirect URL");
  if (rdErr) { setMsg("product-create-msg", rdErr); return; }

  let metadata = null;
  if (metadataStr) {
    try { metadata = JSON.parse(metadataStr); }
    catch { setMsg("product-create-msg", "Metadata deve ser um JSON válido."); return; }
  }

  btn.disabled = true; btn.textContent = "Criando...";
  try {
    const body = { name, slug, amount: cents };
    if (description) body.description = description;
    if (callbackUrl) body.callback_url = callbackUrl;
    if (redirectUrl) body.redirect_url = redirectUrl;
    if (expiresIn) body.expires_in = parseInt(expiresIn, 10);
    if (metadata) body.metadata = metadata;
    const res = await apiFetch("/api/products", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("product-create-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao criar produto."); return; }

    // Upload image after product creation
    if (imageFile) {
      const productId = data.product?.id || data.id;
      try { await uploadImage(imageFile, "product", productId); }
      catch (_uploadErr) { showToast("Produto criado, mas falha no upload da imagem."); }
    }

    salesProductsCache = null;
    showToast("Produto criado!");
    navigate("#merchant-products");
  } catch (e) {
    if (!e.blocked) setMsg("product-create-msg", e.message || "Erro ao criar produto.");
  } finally {
    btn.disabled = false; btn.textContent = "Criar Produto";
  }
});

// Products — edit save
document.getElementById("btn-product-edit-save")?.addEventListener("click", async () => {
  const productId = document.getElementById("btn-product-edit-save")?.dataset.productId;
  if (!productId) return;
  const name = document.getElementById("product-edit-name")?.value.trim();
  const slug = document.getElementById("product-edit-slug")?.value.trim();
  const amountInput = document.getElementById("product-edit-amount");
  const description = document.getElementById("product-edit-description")?.value.trim();
  const imageFile = productEditImageRow.getFile();
  const imageRemoved = productEditImageRow.isMarkedForRemoval();
  const callbackUrl = document.getElementById("product-edit-callback-url")?.value.trim();
  const redirectUrl = document.getElementById("product-edit-redirect-url")?.value.trim();
  const expiresIn = document.getElementById("product-edit-expires")?.value;
  const metadataStr = document.getElementById("product-edit-metadata")?.value.trim();
  const btn = document.getElementById("btn-product-edit-save");
  setMsg("product-edit-msg", "");

  // Validation
  if (!name || name.length < 2) { setMsg("product-edit-msg", "Informe um Nome com pelo menos 2 caracteres."); return; }
  if (name.length > 80) { setMsg("product-edit-msg", "Nome deve ter no máximo 80 caracteres."); return; }
  const slugErr = validateSlug(slug);
  if (slugErr) { setMsg("product-edit-msg", slugErr); return; }
  const cents = toCents(amountInput?.value || "");
  if (!cents || cents < 500) { setMsg("product-edit-msg", `Valor mínimo: ${formatBRL(500)}`); return; }
  if (cents > 300000) { setMsg("product-edit-msg", `Valor máximo: ${formatBRL(300000)}`); return; }
  const cbErr = validateHttpsUrl(callbackUrl, "Callback URL");
  if (cbErr) { setMsg("product-edit-msg", cbErr); return; }
  const rdErr = validateHttpsUrl(redirectUrl, "Redirect URL");
  if (rdErr) { setMsg("product-edit-msg", rdErr); return; }

  let metadata = null;
  if (metadataStr) {
    try { metadata = JSON.parse(metadataStr); }
    catch { setMsg("product-edit-msg", "Metadata deve ser um JSON válido."); return; }
  }

  btn.disabled = true; btn.textContent = "Salvando...";
  try {
    const body = { name, slug, amount: cents };
    if (description) body.description = description;
    else body.description = null;
    if (callbackUrl) body.callback_url = callbackUrl;
    else body.callback_url = null;
    if (redirectUrl) body.redirect_url = redirectUrl;
    else body.redirect_url = null;
    body.expires_in = expiresIn ? parseInt(expiresIn, 10) : 1200;
    if (metadata) body.metadata = metadata;
    else body.metadata = null;
    const res = await apiFetch(`/api/products/${productId}`, { method: "PATCH", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("product-edit-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao salvar."); return; }

    // Handle image upload or removal
    if (imageFile) {
      try { await uploadImage(imageFile, "product", productId); }
      catch (_uploadErr) { showToast("Produto salvo, mas falha no upload da imagem."); }
    } else if (imageRemoved) {
      try { await deleteImageApi("product", productId); }
      catch { /* ignore deletion errors */ }
    }

    salesProductsCache = null;
    showToast("Produto atualizado!");
    loadProductEditView();
  } catch (e) {
    if (!e.blocked) setMsg("product-edit-msg", e.message || "Erro ao salvar.");
  } finally {
    btn.disabled = false; btn.textContent = "Salvar";
  }
});

// Products — toggle active/inactive
document.getElementById("btn-product-edit-toggle")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-product-edit-toggle");
  const productId = btn?.dataset.productId;
  if (!productId) return;
  const isActive = btn.dataset.isActive === "1";
  const action = isActive ? "deactivate" : "activate";
  const label = isActive ? "Desativando..." : "Ativando...";

  btn.disabled = true; btn.textContent = label;
  setMsg("product-edit-msg", "");
  try {
    const res = await apiFetch(`/api/products/${productId}/${action}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { setMsg("product-edit-msg", data?.response?.errorMessage || data?.errorMessage || "Erro."); return; }
    salesProductsCache = null;
    showToast(isActive ? "Produto desativado." : "Produto ativado!");
    loadProductEditView();
  } catch (e) {
    if (!e.blocked) setMsg("product-edit-msg", e.message || "Erro.");
  } finally {
    btn.disabled = false;
    btn.textContent = isActive ? "Desativar" : "Ativar";
  }
});

formatCurrencyInput(document.getElementById("checkout-amount"), "deposito");
formatCurrencyInput(document.getElementById("product-create-amount"), "deposito");
formatCurrencyInput(document.getElementById("product-edit-amount"), "deposito");

// ===== Initialize =====
const isPWA = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;

const hashBase = window.location.hash.split("?")[0];
if (isPWA || (hashBase && hashBase !== "#" && hashBase !== "#landing")) {
  goToAppropriateScreen();
} else if (isLoggedIn()) {
  goToAppropriateScreen();
}
initRouter();
