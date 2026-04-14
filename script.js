// DePix — Main entry point (ES module)

import { route, navigate, initRouter } from "./router.js";
import { isLoggedIn, setAuth, clearAuth, getUser, getRefreshToken } from "./auth.js";
import { apiFetch } from "./api.js";
import {
  getAddresses, addAddress, removeAddress,
  getSelectedAddress, setSelectedAddress,
  abbreviateAddress, hasAddresses
} from "./addresses.js";
import { toCents, formatBRL, formatDePix, escapeHtml } from "./utils.js";
import { validateLiquidAddress, validatePhone, validatePixKey, validateCPF, validateCNPJ, formatPixKey, preparePixKeyForApi } from "./validation.js";
import { showToast, setMsg, goToAppropriateScreen as _goToAppropriateScreen } from "./script-helpers.js";
import { captureReferralCode, buildRegistrationBody, clearReferralCode, buildAffiliateLink, renderReferralsHTML, generateFingerprint } from "./affiliates.js";
import { renderBrandedQr } from "./qr.js";

// ===== Constants =====
const MIN_VALOR_CENTS = 500;
const MAX_VALOR_CENTS = 300000;
let qrCopyPaste = "";
let deferredPrompt = null;
let pendingAddressChange = "";
let pendingAddressDelete = "";
let modoSaque = false;
let modoConvert = false;
let brswapConfig = null;
let valorModeIsPix = false;
let saqueDepositAddress = "";
let lastDepositQrId = "";
let lastWithdrawalId = "";
let transactionsPollingInterval = null;

// Register service worker with update detection
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").then(reg => {
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

// Wallet guide modal
document.getElementById("wallet-guide-link")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("wallet-guide-modal")?.classList.remove("hidden");
});
document.getElementById("btn-wallet-guide-register")?.addEventListener("click", () => {
  document.getElementById("wallet-guide-modal")?.classList.add("hidden");
  document.getElementById("new-addr-input").value = "";
  setMsg("add-addr-msg", "");
  document.getElementById("add-addr-modal")?.classList.remove("hidden");
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

function updateAddrDisplay() {
  const addr = getSelectedAddress();
  const display = document.getElementById("addr-display");
  if (display) {
    display.innerText = addr ? abbreviateAddress(addr) : "Nenhum endereço";
    display.title = addr || "";
  }
}

function switchMode(mode) {
  const modes = ["deposit", "withdraw", "convert"];
  const buttons = { deposit: "modeDeposit", withdraw: "modeWithdraw", convert: "modeConvert" };
  const screens = { deposit: "telaDeposito", withdraw: "telaSaque", convert: "telaConverter" };

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
    if (container) container.innerHTML = "";
    document.getElementById("converterError")?.classList.add("hidden");
    document.getElementById("converterLoading")?.classList.add("hidden");
    if (brswapMessageHandler) {
      window.removeEventListener("message", brswapMessageHandler);
      brswapMessageHandler = null;
    }
  }

  modoSaque = mode === "withdraw";
  modoConvert = mode === "convert";

  // Load BRSwap widget when entering convert mode
  if (mode === "convert") loadBrswapWidget();
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

  container.innerHTML = "";
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
    container.innerHTML = "";
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
      container.innerHTML = "";
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
  if (!modoSaque && !modoConvert) return;
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
  const addr = getSelectedAddress();

  if (!valorInput.value) {
    setMsg("mensagem", "Informe o valor");
    return;
  }

  if (!addr) {
    setMsg("mensagem", "Selecione um endereço no menu antes de continuar");
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
  const addr = getSelectedAddress();

  if (!valorSaqueInput.value || !pixKeyInput.value.trim()) {
    setMsg("mensagemSaque", "Preencha todos os campos");
    return;
  }

  if (!addr) {
    setMsg("mensagemSaque", "Selecione um endereço no menu antes de continuar");
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
      pixKey: pixKeyForApi,
      depixAddress: addr
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

    document.getElementById("saqueDepositAmount").innerText = formatDePix(r.depositAmountInCents);
    document.getElementById("saquePayoutAmount").innerText = formatBRL(r.payoutAmountInCents);
    saqueDepositAddress = r.depositAddress;
    const addrShort = r.depositAddress.length > 16
      ? r.depositAddress.slice(0, 8) + "…" + r.depositAddress.slice(-8)
      : r.depositAddress;
    document.getElementById("saqueAddress").innerText = addrShort;

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
      infoEl.innerHTML = `${warnIcon} Sacando ${formatBRL(r.payoutAmountInCents)} para a chave Pix <b>${escapeHtml(pixResult.formatted)}</b>. Confira com cuidado antes de enviar.`;
      infoEl.classList.remove("hidden");
    }
    const amountEl = document.getElementById("saqueWarningAmount");
    if (amountEl) {
      amountEl.innerHTML = `${warnIcon} Envie EXATAMENTE ${formatDePix(r.depositAmountInCents)}. Qualquer outro valor ou moeda causará perda permanente.`;
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

// Logout
document.getElementById("menu-logout")?.addEventListener("click", () => {
  closeMenu();
  const refreshToken = getRefreshToken();
  clearAuth();
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

document.getElementById("menu-select-addr")?.addEventListener("click", () => {
  closeMenu();
  renderAddressList();
  document.getElementById("select-addr-modal").classList.remove("hidden");
});

document.getElementById("close-select-addr")?.addEventListener("click", () => {
  document.getElementById("select-addr-modal").classList.add("hidden");
});

function renderAddressList() {
  const container = document.getElementById("addr-list");
  const addresses = getAddresses();
  const selected = getSelectedAddress();

  if (addresses.length === 0) {
    container.innerHTML = '<p class="info-text">Nenhum endereço cadastrado.</p>';
    return;
  }

  container.innerHTML = addresses.map(addr => {
    const isSelected = addr === selected;
    const safe = escapeHtml(addr);
    return `
      <div class="addr-list-item${isSelected ? " selected" : ""}" data-addr="${safe}">
        <div class="addr-radio"></div>
        <span class="addr-text" title="${safe}">${escapeHtml(abbreviateAddress(addr))}</span>
        <button class="addr-delete" data-delete="${safe}" title="Remover">🗑</button>
      </div>
    `;
  }).join("");

  container.querySelectorAll(".addr-list-item").forEach(item => {
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("addr-delete")) return;
      const addr = item.dataset.addr;
      const current = getSelectedAddress();

      if (addr !== current) {
        pendingAddressChange = addr;
        document.getElementById("select-addr-modal").classList.add("hidden");
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
      document.getElementById("select-addr-modal").classList.add("hidden");
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

// Add address
document.getElementById("menu-add-addr")?.addEventListener("click", () => {
  closeMenu();
  document.getElementById("new-addr-input").value = "";
  setMsg("add-addr-msg", "");
  document.getElementById("add-addr-modal").classList.remove("hidden");
});

document.getElementById("btn-add-first-address")?.addEventListener("click", () => {
  document.getElementById("wallet-guide-modal")?.classList.remove("hidden");
});

document.getElementById("close-add-addr")?.addEventListener("click", () => {
  document.getElementById("add-addr-modal").classList.add("hidden");
});

document.getElementById("btn-save-addr")?.addEventListener("click", () => {
  const addr = document.getElementById("new-addr-input").value.trim();
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

  document.getElementById("add-addr-modal").classList.add("hidden");
  updateAddrDisplay();
  showToast("Endereço cadastrado com sucesso");

  if (window.location.hash === "#no-address") {
    navigate("#home");
  }
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
  list.innerHTML = html;
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
    list.innerHTML = "";
    if (empty) empty.classList.remove("hidden");
    return;
  }

  if (empty) empty.classList.add("hidden");
  list.innerHTML = payments.map(p => {
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
  }).join("");
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
document.getElementById("btn-request-payment")?.addEventListener("click", () => {
  document.getElementById("payment-warning-modal")?.classList.remove("hidden");
});

document.getElementById("btn-payment-warning-ok")?.addEventListener("click", () => {
  document.getElementById("payment-warning-modal")?.classList.add("hidden");
  document.getElementById("payment-address-input").value = "";
  setMsg("payment-address-msg", "");
  document.getElementById("payment-address-modal")?.classList.remove("hidden");
});

document.getElementById("btn-payment-address-cancel")?.addEventListener("click", () => {
  document.getElementById("payment-address-modal")?.classList.add("hidden");
});

document.getElementById("btn-payment-address-submit")?.addEventListener("click", () => {
  const addr = document.getElementById("payment-address-input").value.trim();
  const { valid, error } = validateLiquidAddress(addr);
  if (!valid) {
    setMsg("payment-address-msg", error || "Endereço Liquid inválido");
    return;
  }
  document.getElementById("payment-address-modal")?.classList.add("hidden");
  const amount = document.getElementById("affiliate-commission-value").innerText;
  document.getElementById("payment-confirm-amount").innerText = amount;
  const addrShort = addr.length > 14 ? `${addr.slice(0, 8)}...${addr.slice(-4)}` : addr;
  document.getElementById("payment-confirm-address").innerText = addrShort;
  document.getElementById("payment-confirm-modal")?.classList.remove("hidden");
  window._paymentAddress = addr;
});

document.getElementById("btn-payment-confirm-cancel")?.addEventListener("click", () => {
  document.getElementById("payment-confirm-modal")?.classList.add("hidden");
});

document.getElementById("btn-payment-confirm")?.addEventListener("click", async () => {
  const btn = document.getElementById("btn-payment-confirm");
  btn.disabled = true;
  btn.innerText = "Enviando...";
  try {
    const res = await apiFetch("/api/reports", {
      method: "POST",
      body: JSON.stringify({
        tipo: "solicitar_comissao",
        liquidAddress: window._paymentAddress
      })
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data?.response?.errorMessage || "Erro ao solicitar pagamento");
      return;
    }
    document.getElementById("payment-confirm-modal")?.classList.add("hidden");
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
  list.innerHTML = '<div id="transactions-sentinel" aria-hidden="true" style="height:1px"></div>';
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
  const type = document.querySelector(".extrato-pill.active")?.dataset.filterType || "all";
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
  list.innerHTML = '<div id="transactions-sentinel" aria-hidden="true" style="height:1px"></div>';
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
    sentinel.insertAdjacentHTML("beforebegin", html);
  } else {
    list.insertAdjacentHTML("beforeend", html);
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

// Extrato: pill toggle filters (type)
document.querySelectorAll(".extrato-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".extrato-pill").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    applyFilters();
    updateFilterBadge();
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

document.querySelectorAll(".extrato-period-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".extrato-period-btn").forEach(b => b.classList.remove("active"));
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
    }
    applyFilters();
    updateFilterBadge();
  });
});

// Extrato: update filter badge count
function updateFilterBadge() {
  const type = document.querySelector(".extrato-pill.active")?.dataset.filterType || "all";
  const status = document.getElementById("filter-status")?.value || "";
  const period = document.querySelector(".extrato-period-btn.active")?.dataset.period || "all";
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
document.getElementById("filter-search")?.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => { applyFilters(); updateFilterBadge(); }, 200);
});

// Extrato: auto-filter on change
document.getElementById("filter-status")?.addEventListener("change", () => { applyFilters(); updateFilterBadge(); });
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
document.getElementById("merchant-checkouts-list")?.addEventListener("click", handleCopyableClick);
document.getElementById("api-keys-list")?.addEventListener("click", handleCopyableClick);
document.getElementById("sales-list")?.addEventListener("click", handleCopyableClick);

// Extrato: clear filters
document.getElementById("extrato-clear-filters")?.addEventListener("click", () => {
  // Reset search
  const searchInput = document.getElementById("filter-search");
  if (searchInput) searchInput.value = "";
  // Reset type
  document.querySelectorAll(".extrato-pill").forEach(b => b.classList.remove("active"));
  document.querySelector('.extrato-pill[data-filter-type="all"]')?.classList.add("active");
  // Reset status
  const status = document.getElementById("filter-status");
  if (status) status.value = "";
  // Reset period
  document.querySelectorAll(".extrato-period-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.extrato-period-btn[data-period="all"]')?.classList.add("active");
  document.getElementById("extrato-custom-range")?.classList.add("hidden");
  const startDate = document.getElementById("filter-start-date");
  const endDate = document.getElementById("filter-end-date");
  if (startDate) startDate.value = "";
  if (endDate) endDate.value = "";
  applyFilters();
  updateFilterBadge();
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
  if (converterContent) converterContent.innerHTML = "";
  document.getElementById("converterError")?.classList.add("hidden");
  document.getElementById("converterLoading")?.classList.add("hidden");
  // Fetch BRSwap feature config
  fetchBrswapConfig();
});

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
  const copyIcon = '<svg class="copy-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  let paidIn = "";
  if (c.status === "completed" && c.created_at && c.processing_at) {
    const diffMs = new Date(c.processing_at) - new Date(c.created_at);
    const mins = Math.round(diffMs / 60000);
    paidIn = `<span class="transaction-detail"><span class="transaction-detail-label">Pago em:</span> <span class="transaction-detail-value">${mins}min</span></span>`;
  }
  return `<div class="transaction-item">
    <div class="transaction-info">
      <span class="transaction-amount">${amount}</span>
      <span class="transaction-date">${formatDateShort(c.created_at)}</span>
    </div>
    <span class="transaction-status ${colorClass}">${statusLabel}</span>
    ${desc}
    <div class="transaction-details">
      <span class="transaction-detail copyable mono" data-copy="${escapeHtml(c.payment_url || `https://pay.depixapp.com/${c.id}`)}"><span class="transaction-detail-label">Link:</span> <span class="transaction-detail-value">${escapeHtml(abbreviateHash(c.payment_url || `https://pay.depixapp.com/${c.id}`, 25, 8))}</span>${copyIcon}</span>
      ${paidIn}
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
      document.getElementById("merchant-create").classList.remove("hidden");
      // Pre-fill Liquid address from saved addresses
      const savedAddrs = getAddresses();
      const dropdown = document.getElementById("merchant-addr-dropdown");
      const addrInput = document.getElementById("merchant-liquid-addr");
      const optionsEl = document.getElementById("merchant-addr-options");
      const toggleText = document.getElementById("merchant-addr-toggle-text");
      if (savedAddrs.length > 0 && dropdown && optionsEl) {
        optionsEl.innerHTML = savedAddrs.map(a => {
          const abbr = abbreviateAddress(a);
          return `<div class="custom-dropdown-option" data-value="${escapeHtml(a)}">${escapeHtml(abbr)}</div>`;
        }).join("");
        dropdown.classList.remove("hidden");
        const selected = getSelectedAddress();
        if (selected && !addrInput.value) {
          addrInput.value = selected;
          if (toggleText) toggleText.textContent = abbreviateAddress(selected);
        }
      } else if (dropdown) {
        dropdown.classList.add("hidden");
      }
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
  const bannerDismissed = localStorage.getItem("depix-ship-banner-dismissed");
  document.getElementById("merchant-ship-banner")?.classList.toggle("hidden", !!bannerDismissed);
  document.getElementById("checkout-result")?.classList.add("hidden");

  try {
    const res = await apiFetch("/api/checkouts?limit=10");
    if (!res.ok) return;
    const data = await res.json();
    const checkouts = data.checkouts || [];
    const list = document.getElementById("merchant-checkouts-list");
    const empty = document.getElementById("merchant-checkouts-empty");
    if (checkouts.length === 0) {
      list.innerHTML = "";
      empty?.classList.remove("hidden");
    } else {
      empty?.classList.add("hidden");
      list.innerHTML = checkouts.map(c => renderCheckoutItem(c)).join("");
    }
  } catch (e) { if (!e.blocked) showToast("Erro ao carregar cobranças."); }
}

// === Minha Conta ===
async function loadAccountView() {
  showMerchantMenu();
  try {
    const res = await apiFetch("/api/merchants/me");
    if (res.ok) { const d = await res.json(); merchantData = d.merchant || d; }
    const container = document.getElementById("merchant-account-list");
    if (merchantData && container) {
      const fields = [
        { label: "Nome", value: merchantData.business_name, field: "business_name" },
        { label: "Endereço Liquid", value: abbreviateHash(merchantData.liquid_address, 12, 8), field: "liquid_address" },
        { label: "CNPJ", value: merchantData.cnpj, field: "cnpj" },
        { label: "Website", value: merchantData.website, field: "website" },
        { label: "Logo URL", value: merchantData.logo_url, field: "logo_url" },
        { label: "Callback URL padrão", value: merchantData.default_callback_url, field: "default_callback_url" },
        { label: "Redirect URL padrão", value: merchantData.default_redirect_url, field: "default_redirect_url" },
      ];
      container.innerHTML = '<div class="account-list">' + fields.map(f => {
        const hasValue = !!f.value;
        const valueClass = `account-field-value${f.field === "liquid_address" ? " mono" : ""}${hasValue ? "" : " empty"}`;
        const display = hasValue ? escapeHtml(f.value) : "Não informado";
        return `<div class="account-field">
          <div class="account-field-label">${f.label}</div>
          <div class="account-field-value-row">
            <span class="${valueClass}">${display}</span>
            <button class="merchant-edit-btn" data-field="${f.field}">${hasValue ? "Editar" : "Adicionar"}</button>
          </div>
        </div>`;
      }).join("") + '</div>';
      // Re-attach edit handlers
      container.querySelectorAll(".merchant-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const field = btn.dataset.field;
          const labels = { business_name: "Nome do negócio", liquid_address: "Endereço Liquid", cnpj: "CNPJ", website: "Website", logo_url: "Logo URL", default_callback_url: "Callback URL padrão", default_redirect_url: "Redirect URL padrão" };
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
      list.innerHTML = "";
      empty?.classList.remove("hidden");
    } else {
      empty?.classList.add("hidden");
      list.innerHTML = keys.map(k => {
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
        const keyDisplay = k.key_plain || (k.prefix + "...");
        const labelText = k.label && k.label !== "Produção" && k.label !== "Teste" ? k.label : null;
        const copyIcon = '<svg class="copy-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        return `<div class="api-key-card">
          <div class="api-key-top-row">${typeBadge}${labelText ? `<span class="api-key-label">${escapeHtml(labelText)}</span>` : ""}<button class="btn-revoke-key" data-key-id="${escapeHtml(k.id)}">Revogar</button></div>
          <div class="api-key-value copyable" data-copy="${escapeHtml(keyDisplay)}"><span class="mono">${escapeHtml(keyDisplay)}</span>${copyIcon}</div>
          <div class="api-key-detail"><span class="${expiresClass}">${expiresText}</span> · usado: ${lastUsed}</div>
        </div>`;
      }).join("");

      // Expired key alert
      const expiredKey = keys.find(k => k.expires_at && new Date(k.expires_at) < new Date());
      const expAlert = document.getElementById("merchant-alert-expired-key");
      if (expiredKey && expAlert) {
        expAlert.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>Sua chave ${escapeHtml(expiredKey.prefix)}...${expiredKey.label ? " (" + escapeHtml(expiredKey.label) + ")" : ""} expirou. Crie uma nova.`;
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

async function loadSalesView() {
  stopSalesPolling();
  showMerchantMenu();
  document.getElementById("sales-loading")?.classList.remove("hidden");
  document.getElementById("sales-empty")?.classList.add("hidden");
  setMsg("sales-msg", "");
  const list = document.getElementById("sales-list");
  list.innerHTML = '<div id="sales-sentinel" aria-hidden="true" style="height:1px"></div>';

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
  list.innerHTML = '<div id="sales-sentinel" aria-hidden="true" style="height:1px"></div>';
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
  sentinel?.insertAdjacentHTML("beforebegin", html);
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
      list.innerHTML = "";
      document.getElementById("webhook-logs-empty")?.classList.remove("hidden");
      return;
    }

    list.innerHTML = logs.map(log => {
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
    }).join("");

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
  if (list) list.innerHTML = "";

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

    list.innerHTML = products.map(p => {
      const statusBadge = p.active
        ? '<span class="badge badge-green">Ativo</span>'
        : '<span class="badge badge-gray">Inativo</span>';
      const amount = formatBRL(p.amount);
      const desc = p.description
        ? `<span class="product-card-desc">${escapeHtml(p.description)}</span>`
        : '';
      const checkoutCount = p.total_checkouts || 0;
      return `<div class="product-card">
        <div class="product-card-header">
          <div class="product-card-name">${escapeHtml(p.slug)}</div>
          ${statusBadge}
        </div>
        <div class="product-card-amount">${amount}</div>
        ${desc}
        <div class="product-card-footer">
          <span class="product-card-checkouts">${checkoutCount} checkout${checkoutCount !== 1 ? 's' : ''}</span>
          <div class="product-card-actions">
            <button class="merchant-text-btn btn-product-checkouts" data-product-id="${escapeHtml(p.id)}">Checkouts</button>
            <button class="merchant-text-btn btn-product-edit" data-product-id="${escapeHtml(p.id)}">Editar</button>
          </div>
        </div>
      </div>`;
    }).join("");

    // Attach edit/checkout handlers
    list.querySelectorAll(".btn-product-edit").forEach(btn => {
      btn.addEventListener("click", () => navigate(`#merchant-product-edit?id=${btn.dataset.productId}`));
    });
    list.querySelectorAll(".btn-product-checkouts").forEach(btn => {
      btn.addEventListener("click", () => navigate(`#merchant-product-checkouts?id=${btn.dataset.productId}`));
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
  document.getElementById("product-create-slug").value = "";
  document.getElementById("product-create-amount").value = "";
  document.getElementById("product-create-description").value = "";
  document.getElementById("product-create-image-url").value = "";
  document.getElementById("product-create-callback-url").value = "";
  document.getElementById("product-create-redirect-url").value = "";
  document.getElementById("product-create-expires").value = "";
  document.getElementById("product-create-metadata").value = "";
  setMsg("product-create-msg", "");
}

async function loadProductEditView() {
  showMerchantMenu();
  const productId = getProductIdFromHash();
  if (!productId) { navigate("#merchant-products"); return; }

  setMsg("product-edit-msg", "");
  document.getElementById("product-edit-url-row")?.classList.add("hidden");

  try {
    const res = await apiFetch(`/api/products/${productId}`);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      setMsg("product-edit-msg", e?.errorMessage || "Erro ao carregar produto.");
      return;
    }
    const data = await res.json();
    const product = data.product || data;

    document.getElementById("product-edit-slug").value = product.slug || "";
    document.getElementById("product-edit-amount").value = product.amount ? formatBRL(product.amount) : "";
    document.getElementById("product-edit-description").value = product.description || "";
    document.getElementById("product-edit-image-url").value = product.image_url || "";
    document.getElementById("product-edit-callback-url").value = product.callback_url || "";
    document.getElementById("product-edit-redirect-url").value = product.redirect_url || "";
    document.getElementById("product-edit-expires").value = product.expires_in ? String(product.expires_in) : "";
    document.getElementById("product-edit-metadata").value = product.metadata ? JSON.stringify(product.metadata, null, 2) : "";

    // Product URL
    if (product.slug && merchantData?.username) {
      const productUrl = `https://pay.depixapp.com/${merchantData.username}/${product.slug}`;
      document.getElementById("product-edit-url").value = productUrl;
      document.getElementById("product-edit-url-row")?.classList.remove("hidden");
    }

    // Toggle button label
    const toggleBtn = document.getElementById("btn-product-edit-toggle");
    if (toggleBtn) {
      toggleBtn.textContent = product.active ? "Desativar" : "Ativar";
      toggleBtn.dataset.productId = productId;
      toggleBtn.dataset.isActive = product.active ? "1" : "0";
    }

    // Save button
    const saveBtn = document.getElementById("btn-product-edit-save");
    if (saveBtn) saveBtn.dataset.productId = productId;

  } catch (e) {
    if (!e.blocked) setMsg("product-edit-msg", e.message || "Erro ao carregar produto.");
  }
}

async function loadProductCheckoutsView() {
  showMerchantMenu();
  const productId = getProductIdFromHash();
  if (!productId) { navigate("#merchant-products"); return; }

  document.getElementById("product-checkouts-loading")?.classList.remove("hidden");
  document.getElementById("product-checkouts-empty")?.classList.add("hidden");
  setMsg("product-checkouts-msg", "");
  const list = document.getElementById("product-checkouts-list");
  if (list) list.innerHTML = "";
  document.getElementById("product-checkouts-info").innerHTML = "";

  try {
    // Fetch product details and checkouts
    const [prodRes, checkoutsRes] = await Promise.all([
      apiFetch(`/api/products/${productId}`),
      apiFetch(`/api/products/${productId}/checkouts`),
    ]);

    if (prodRes.ok) {
      const prodData = await prodRes.json();
      const product = prodData.product || prodData;
      document.getElementById("product-checkouts-title").textContent = `Checkouts: ${product.slug || ""}`;
      document.getElementById("product-checkouts-info").innerHTML = `
        <div class="product-checkouts-summary">
          <span>${formatBRL(product.amount)}</span>
          <span class="badge ${product.active ? 'badge-green' : 'badge-gray'}">${product.active ? 'Ativo' : 'Inativo'}</span>
        </div>`;
    } else {
      setMsg("product-checkouts-msg", "Não foi possível carregar os detalhes do produto.");
    }

    if (!checkoutsRes.ok) {
      const e = await checkoutsRes.json().catch(() => ({}));
      setMsg("product-checkouts-msg", e?.errorMessage || "Erro ao carregar checkouts.");
      return;
    }
    const data = await checkoutsRes.json();
    const checkouts = data.checkouts || [];

    if (checkouts.length === 0) {
      document.getElementById("product-checkouts-empty")?.classList.remove("hidden");
      return;
    }

    list.innerHTML = checkouts.map(c => renderCheckoutItem(c)).join("");
  } catch (e) {
    if (!e.blocked) setMsg("product-checkouts-msg", e.message || "Erro ao carregar checkouts.");
  } finally {
    document.getElementById("product-checkouts-loading")?.classList.add("hidden");
  }
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
route("#merchant-product-checkouts", () => { stopSalesPolling(); merchantGuard(loadProductCheckoutsView); });
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

// Dismiss ship banner
document.getElementById("dismiss-ship-banner")?.addEventListener("click", () => {
  document.getElementById("merchant-ship-banner")?.classList.add("hidden");
  localStorage.setItem("depix-ship-banner-dismissed", "1");
});

// Create checkout
document.getElementById("btn-create-checkout")?.addEventListener("click", async () => {
  const amountInput = document.getElementById("checkout-amount");
  const desc = document.getElementById("checkout-description")?.value.trim();
  let image = document.getElementById("checkout-image")?.value.trim();
  if (image && !image.startsWith("http://") && !image.startsWith("https://")) {
    image = "https://" + image;
  }
  const btn = document.getElementById("btn-create-checkout");
  setMsg("checkout-create-msg", "");
  const cents = toCents(amountInput?.value || "");
  if (!cents || cents < 500) { setMsg("checkout-create-msg", `Valor mínimo: ${formatBRL(500)}`); return; }

  btn.disabled = true;
  btn.textContent = "Criando...";
  try {
    const body = { amount: cents };
    if (desc) body.description = desc;
    if (image) body.image_url = image;
    const res = await apiFetch("/api/checkouts", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("checkout-create-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao criar checkout."); return; }
    document.getElementById("checkout-link").value = data.payment_url || "";
    document.getElementById("checkout-result")?.classList.remove("hidden");
    amountInput.value = "";
    document.getElementById("checkout-description").value = "";
    document.getElementById("checkout-image").value = "";
    showToast("Link criado!");
    loadChargeView();
  } catch (e) {
    if (!e.blocked) setMsg("checkout-create-msg", e.message || "Erro ao criar checkout.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Criar link de pagamento";
  }
});
document.getElementById("checkout-image-info")?.addEventListener("click", () => {
  document.getElementById("checkout-image-modal")?.classList.remove("hidden");
});
document.getElementById("close-checkout-image-modal")?.addEventListener("click", () => {
  document.getElementById("checkout-image-modal")?.classList.add("hidden");
});
document.getElementById("btn-copy-checkout-link")?.addEventListener("click", () => {
  const link = document.getElementById("checkout-link")?.value;
  if (link) { navigator.clipboard.writeText(link).then(() => showToast("Link copiado!")).catch(() => showToast("Erro ao copiar")); }
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
 "close-merchant-password", "close-webhook-secret", "close-merchant-edit"].forEach(id => {
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
  if ((field === "logo_url" || field === "default_callback_url" || field === "default_redirect_url") && value) {
    const urlError = validateHttpsUrl(value, field.replace(/_url$/, " URL").replace(/_/g, " "));
    if (urlError) { setMsg("merchant-edit-modal-msg", urlError); btn.disabled = false; btn.textContent = "Salvar"; return; }
  }
  try {
    let sendValue = value || null;
    if (field === "website" && value) sendValue = normalizeWebsite(value);
    const body = { [field]: sendValue };
    if (field === "liquid_address" && pendingLiquidPassword) {
      body.password = pendingLiquidPassword;
    }
    const res = await apiFetch("/api/merchants/me", { method: "PATCH", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("merchant-edit-modal-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao salvar."); return; }
    if (field === "liquid_address") pendingLiquidPassword = null;
    document.getElementById("merchant-edit-modal")?.classList.add("hidden");
    merchantData = null; // Force reload
    showToast("Dados atualizados");
    loadAccountView();
  } catch (e) { setMsg("merchant-edit-modal-msg", e.message || "Erro ao salvar."); }
  finally { btn.disabled = false; btn.textContent = "Salvar"; }
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
      document.getElementById("merchant-edit-title").textContent = "Editar Endereço Liquid";
      document.getElementById("merchant-edit-input").value = merchantData?.liquid_address || "";
      document.getElementById("merchant-edit-input").dataset.field = "liquid_address";
      pendingLiquidPassword = password;
      document.getElementById("merchant-edit-modal")?.classList.remove("hidden");
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

// Merchant address dropdown
document.getElementById("merchant-addr-toggle")?.addEventListener("click", () => {
  const dropdown = document.getElementById("merchant-addr-dropdown");
  const options = document.getElementById("merchant-addr-options");
  const isOpen = dropdown.classList.contains("open");
  dropdown.classList.toggle("open", !isOpen);
  options.classList.toggle("hidden", isOpen);
});
document.getElementById("merchant-addr-options")?.addEventListener("click", (e) => {
  const opt = e.target.closest(".custom-dropdown-option");
  if (!opt) return;
  const value = opt.dataset.value;
  const input = document.getElementById("merchant-liquid-addr");
  const toggleText = document.getElementById("merchant-addr-toggle-text");
  if (value && input) input.value = value;
  if (toggleText) toggleText.textContent = opt.textContent;
  // Mark selected
  document.querySelectorAll("#merchant-addr-options .custom-dropdown-option").forEach(o => o.classList.remove("selected"));
  opt.classList.add("selected");
  // Close dropdown
  document.getElementById("merchant-addr-dropdown").classList.remove("open");
  document.getElementById("merchant-addr-options").classList.add("hidden");
});
// Close dropdown on outside click
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("merchant-addr-dropdown");
  if (dropdown && !dropdown.contains(e.target)) {
    dropdown.classList.remove("open");
    document.getElementById("merchant-addr-options")?.classList.add("hidden");
  }
});

// Create merchant
document.getElementById("btn-create-merchant")?.addEventListener("click", async () => {
  const name = document.getElementById("merchant-name")?.value.trim();
  const addr = document.getElementById("merchant-liquid-addr")?.value.trim();
  const cnpj = document.getElementById("merchant-cnpj")?.value.trim();
  const website = document.getElementById("merchant-website")?.value.trim();
  const btn = document.getElementById("btn-create-merchant");
  setMsg("merchant-create-msg", "");
  if (!name) { setMsg("merchant-create-msg", "Informe o nome do negócio."); return; }
  if (!addr) { setMsg("merchant-create-msg", "Informe o endereço Liquid."); return; }
  const addrValid = validateLiquidAddress(addr);
  if (!addrValid.valid) { setMsg("merchant-create-msg", addrValid.error); return; }
  if (cnpj) { const cnpjResult = validateCNPJ(cnpj); if (!cnpjResult.valid) { setMsg("merchant-create-msg", cnpjResult.error); return; } }

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
    merchantData = null;
    showToast("Conta de lojista criada!");
    loadMerchantDispatcher();
  } catch (e) {
    if (!e.blocked) setMsg("merchant-create-msg", e.message || "Erro ao criar conta.");
  } finally { btn.disabled = false; btn.textContent = "Começar"; }
});

// Sales filter toggle
document.getElementById("sales-filter-toggle")?.addEventListener("click", () => {
  const panel = document.getElementById("sales-filter-panel");
  const toggle = document.getElementById("sales-filter-toggle");
  panel.classList.toggle("hidden", !panel.classList.contains("hidden"));
  toggle.classList.toggle("open");
});
// Sales status filter
document.getElementById("sales-filter-status")?.addEventListener("change", () => loadSalesView());
// Sales period presets
document.querySelectorAll("[data-sales-period]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-sales-period]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("sales-custom-range")?.classList.toggle("hidden", btn.dataset.salesPeriod !== "custom");
    if (btn.dataset.salesPeriod !== "custom") loadSalesView();
  });
});
// Sales custom date range
document.getElementById("sales-filter-start")?.addEventListener("change", () => loadSalesView());
document.getElementById("sales-filter-end")?.addEventListener("change", () => loadSalesView());
// Sales search (debounced)
let salesSearchTimer;
document.getElementById("sales-filter-search")?.addEventListener("input", () => {
  clearTimeout(salesSearchTimer);
  salesSearchTimer = setTimeout(() => applySalesFilters(), 200);
});
// Sales clear filters
document.getElementById("sales-clear-filters")?.addEventListener("click", () => {
  document.getElementById("sales-filter-status").value = "";
  document.getElementById("sales-filter-search").value = "";
  document.querySelectorAll("[data-sales-period]").forEach(b => b.classList.remove("active"));
  document.querySelector("[data-sales-period='all']")?.classList.add("active");
  document.getElementById("sales-custom-range")?.classList.add("hidden");
  loadSalesView();
});
// Sales empty CTA
document.getElementById("btn-sales-goto-create")?.addEventListener("click", () => navigate("#merchant-charge"));

// Products — navigate to create
document.getElementById("btn-new-product")?.addEventListener("click", () => navigate("#merchant-product-create"));
document.getElementById("btn-products-goto-create")?.addEventListener("click", () => navigate("#merchant-product-create"));

// Products — create submit
document.getElementById("btn-product-create-submit")?.addEventListener("click", async () => {
  const slug = document.getElementById("product-create-slug")?.value.trim();
  const amountInput = document.getElementById("product-create-amount");
  const description = document.getElementById("product-create-description")?.value.trim();
  const imageUrl = document.getElementById("product-create-image-url")?.value.trim();
  const callbackUrl = document.getElementById("product-create-callback-url")?.value.trim();
  const redirectUrl = document.getElementById("product-create-redirect-url")?.value.trim();
  const expiresIn = document.getElementById("product-create-expires")?.value;
  const metadataStr = document.getElementById("product-create-metadata")?.value.trim();
  const btn = document.getElementById("btn-product-create-submit");
  setMsg("product-create-msg", "");

  // Validation
  const slugErr = validateSlug(slug);
  if (slugErr) { setMsg("product-create-msg", slugErr); return; }
  const cents = toCents(amountInput?.value || "");
  if (!cents || cents < 500) { setMsg("product-create-msg", `Valor mínimo: ${formatBRL(500)}`); return; }
  const imgErr = validateHttpsUrl(imageUrl, "URL da imagem");
  if (imgErr) { setMsg("product-create-msg", imgErr); return; }
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
    const body = { slug, amount: cents };
    if (description) body.description = description;
    if (imageUrl) body.image_url = imageUrl;
    if (callbackUrl) body.callback_url = callbackUrl;
    if (redirectUrl) body.redirect_url = redirectUrl;
    if (expiresIn) body.expires_in = parseInt(expiresIn, 10);
    if (metadata) body.metadata = metadata;
    const res = await apiFetch("/api/products", { method: "POST", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("product-create-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao criar produto."); return; }
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
  const slug = document.getElementById("product-edit-slug")?.value.trim();
  const amountInput = document.getElementById("product-edit-amount");
  const description = document.getElementById("product-edit-description")?.value.trim();
  const imageUrl = document.getElementById("product-edit-image-url")?.value.trim();
  const callbackUrl = document.getElementById("product-edit-callback-url")?.value.trim();
  const redirectUrl = document.getElementById("product-edit-redirect-url")?.value.trim();
  const expiresIn = document.getElementById("product-edit-expires")?.value;
  const metadataStr = document.getElementById("product-edit-metadata")?.value.trim();
  const btn = document.getElementById("btn-product-edit-save");
  setMsg("product-edit-msg", "");

  // Validation
  const slugErr = validateSlug(slug);
  if (slugErr) { setMsg("product-edit-msg", slugErr); return; }
  const cents = toCents(amountInput?.value || "");
  if (!cents || cents < 500) { setMsg("product-edit-msg", `Valor mínimo: ${formatBRL(500)}`); return; }
  const imgErr = validateHttpsUrl(imageUrl, "URL da imagem");
  if (imgErr) { setMsg("product-edit-msg", imgErr); return; }
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
    const body = { slug, amount: cents };
    if (description) body.description = description;
    else body.description = null;
    if (imageUrl) body.image_url = imageUrl;
    else body.image_url = null;
    if (callbackUrl) body.callback_url = callbackUrl;
    else body.callback_url = null;
    if (redirectUrl) body.redirect_url = redirectUrl;
    else body.redirect_url = null;
    if (expiresIn) body.expires_in = parseInt(expiresIn, 10);
    else body.expires_in = null;
    if (metadata) body.metadata = metadata;
    else body.metadata = null;
    const res = await apiFetch(`/api/products/${productId}`, { method: "PATCH", body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { setMsg("product-edit-msg", data?.response?.errorMessage || data?.errorMessage || "Erro ao salvar."); return; }
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
    showToast(isActive ? "Produto desativado." : "Produto ativado!");
    loadProductEditView();
  } catch (e) {
    if (!e.blocked) setMsg("product-edit-msg", e.message || "Erro.");
  } finally {
    btn.disabled = false;
    btn.textContent = isActive ? "Desativar" : "Ativar";
  }
});

// Products — copy product URL
document.getElementById("btn-copy-product-url")?.addEventListener("click", () => {
  const url = document.getElementById("product-edit-url")?.value;
  if (url) { navigator.clipboard.writeText(url).then(() => showToast("URL copiada!")).catch(() => showToast("Erro ao copiar")); }
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
