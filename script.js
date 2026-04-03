// DePix — Main entry point (ES module)

import { route, navigate, initRouter } from "./router.js";
import { isLoggedIn, setAuth, clearAuth, getUser, getRefreshToken } from "./auth.js";
import { apiFetch } from "./api.js";
import {
  getAddresses, addAddress, removeAddress,
  getSelectedAddress, setSelectedAddress,
  abbreviateAddress, hasAddresses
} from "./addresses.js";
import { isAllowedImageUrl, toCents, formatBRL, formatDePix, escapeHtml } from "./utils.js";
import { validateLiquidAddress, validatePhone } from "./validation.js";
import { showToast, setMsg, goToAppropriateScreen as _goToAppropriateScreen } from "./script-helpers.js";
import { captureReferralCode, buildRegistrationBody, clearReferralCode, buildAffiliateLink, renderReferralsHTML, generateFingerprint } from "./affiliates.js";

// ===== Constants =====
const MIN_VALOR_CENTS = 500;
const MAX_VALOR_CENTS = 300000;
let qrCopyPaste = "";
let deferredPrompt = null;
let pendingAddressChange = "";
let reportType = "";
let modoSaque = false;
let modoConvert = false;
let brswapConfig = null;
let valorModeIsPix = false;
let saqueDepositAddress = "";
let lastDepositQrId = "";
let lastWithdrawalId = "";
let transactionsPollingInterval = null;

// Register service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js");
}

// ===== Utility functions =====
// showToast and setMsg are imported from script-helpers.js

function generateBrandedQr(data, imgEl) {
  const size = 300;
  const qrApiUrl = "https://api.qrserver.com/v1/create-qr-code/?size=" + size + "x" + size + "&ecc=H&data=" + encodeURIComponent(data);

  const qrImg = new Image();
  qrImg.crossOrigin = "anonymous";
  qrImg.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Draw dark background
    ctx.fillStyle = "#111921";
    ctx.fillRect(0, 0, size, size);

    // Draw QR on canvas to read pixels
    ctx.drawImage(qrImg, 0, 0, size, size);
    const imageData = ctx.getImageData(0, 0, size, size);
    const pixels = imageData.data;

    // Replace colors: black modules → teal, white → dark bg
    for (let i = 0; i < pixels.length; i += 4) {
      const brightness = pixels[i]; // R channel (grayscale QR)
      if (brightness < 128) {
        // Dark module → teal
        pixels[i] = 56;      // R
        pixels[i + 1] = 227; // G
        pixels[i + 2] = 172; // B
      } else {
        // Light module → dark background
        pixels[i] = 17;      // R
        pixels[i + 1] = 25;  // G
        pixels[i + 2] = 33;  // B
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Draw logo in center with circular background
    const logo = new Image();
    logo.onload = () => {
      const logoSize = size * 0.22;
      const padding = 6;
      const cx = (size - logoSize) / 2;
      const cy = (size - logoSize) / 2;

      // Circle background behind logo
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, logoSize / 2 + padding, 0, Math.PI * 2);
      ctx.fillStyle = "#111921";
      ctx.fill();

      // Draw logo
      ctx.drawImage(logo, cx, cy, logoSize, logoSize);

      // Set result as data URL
      imgEl.src = canvas.toDataURL("image/png");
      imgEl.classList.remove("hidden");
    };
    logo.onerror = () => {
      // Logo failed — show QR without logo
      imgEl.src = canvas.toDataURL("image/png");
      imgEl.classList.remove("hidden");
    };
    logo.src = "./icon-192.png";
  };

  qrImg.onerror = () => {
    // Fallback: plain QR
    imgEl.src = qrApiUrl;
    imgEl.classList.remove("hidden");
  };
  qrImg.src = qrApiUrl;
}

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

  const btn = document.getElementById("btn-register");
  btn.disabled = true;
  btn.innerText = "Criando conta…";

  try {
    let fp = null;
    try { fp = await generateFingerprint(); } catch {}

    const res = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(buildRegistrationBody({ nome, email, whatsapp, usuario, senha }, fp))
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("register-msg", data?.response?.errorMessage || "Erro ao criar conta");
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
    const res = await apiFetch("/api/depix", {
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

    if (!isAllowedImageUrl(data.response.qrImageUrl)) {
      throw new Error("URL do QR Code inválida");
    }

    qrCopyPaste = data.response.qrCopyPaste;
    lastDepositQrId = data.response.id;
    document.getElementById("qrImage").src = data.response.qrImageUrl;
    document.getElementById("qrId").innerText = "ID: " + data.response.id;
    document.getElementById("formDeposito").classList.add("hidden");
    document.getElementById("resultado").classList.remove("hidden");

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
    copyBtn.innerText = "Copiado!";
    copyBtn.classList.add("copy-success");
    setTimeout(() => {
      copyBtn.innerText = "PIX copia e cola";
      copyBtn.classList.remove("copy-success");
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

  const valorCents = toCents(valorSaqueInput.value);

  if (valorCents < MIN_VALOR_CENTS) {
    setMsg("mensagemSaque", "O valor mínimo é R$ 5,00");
    return;
  }
  if (valorCents > MAX_VALOR_CENTS) {
    showLimitModal();
    return;
  }

  // Save PIX key for convenience
  localStorage.setItem("depix-pixkey", pixKeyInput.value.trim());

  const btn = document.getElementById("btnSacar");
  btn.disabled = true;
  btn.innerText = "Processando…";
  document.getElementById("loadingSaque").classList.remove("hidden");

  try {
    const body = {
      pixKey: pixKeyInput.value.trim(),
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
    generateBrandedQr(r.depositAddress, saqueQr);

    // Show warning about exact amount
    const warningEl = document.getElementById("saqueWarning");
    if (warningEl) {
      const warnIcon = '<svg class="saque-warning-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      warningEl.innerHTML = `${warnIcon} Sacando ${formatBRL(r.payoutAmountInCents)} para a chave pix ${pixKeyInput.value.trim()}.<br>Envie EXATAMENTE ${formatDePix(r.depositAmountInCents)}. Se você enviar qualquer outro valor (ou qualquer outra moeda), seus fundos podem ser perdidos para sempre.`;
      warningEl.classList.remove("hidden");
    }

    document.getElementById("formSaque").classList.add("hidden");
    document.getElementById("resultadoSaque").classList.remove("hidden");

  } catch (e) {
    setMsg("mensagemSaque", e.message || "Não foi possível processar. Tente novamente.");
  } finally {
    document.getElementById("loadingSaque").classList.add("hidden");
    btn.disabled = false;
    btn.innerText = "Solicitar transferência";
  }
});

document.getElementById("btnCopyAddress")?.addEventListener("click", async () => {
  const copyBtn = document.getElementById("btnCopyAddress");
  try {
    await navigator.clipboard.writeText(saqueDepositAddress);
    showToast("Endereço copiado.");
    copyBtn.innerText = "Copiado!";
    copyBtn.classList.add("copy-success");
    setTimeout(() => {
      copyBtn.innerText = "Copiar endereço";
      copyBtn.classList.remove("copy-success");
    }, 2000);
  } catch {
    showToast("Não foi possível copiar. Copie manualmente.");
  }
});

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
        document.getElementById("password-modal").classList.remove("hidden");
      }
    });
  });

  container.querySelectorAll(".addr-delete").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const addr = btn.dataset.delete;
      removeAddress(addr);
      renderAddressList();
      updateAddrDisplay();
      if (!hasAddresses()) {
        document.getElementById("select-addr-modal").classList.add("hidden");
        navigate("#no-address");
      }
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

    setSelectedAddress(pendingAddressChange);
    pendingAddressChange = "";
    document.getElementById("password-modal").classList.add("hidden");
    updateAddrDisplay();
    showToast("Endereço alterado com sucesso");
  } catch (e) {
    setMsg("password-modal-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Confirmar";
  }
});

document.getElementById("close-password-modal")?.addEventListener("click", () => {
  pendingAddressChange = "";
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
// REPORTS
// =========================================

document.getElementById("menu-report-depositos")?.addEventListener("click", () => {
  closeMenu();
  reportType = "deposito";
  document.getElementById("report-title").innerText = "Relatório de Depósitos";
  setMsg("report-msg", "");
  navigate("#reports");
});

document.getElementById("menu-report-saques")?.addEventListener("click", () => {
  closeMenu();
  reportType = "saque";
  document.getElementById("report-title").innerText = "Relatório de Saques";
  setMsg("report-msg", "");
  navigate("#reports");
});

document.getElementById("menu-report-comissoes")?.addEventListener("click", () => {
  closeMenu();
  reportType = "comissao";
  document.getElementById("report-title").innerText = "Relatório de Comissões";
  setMsg("report-msg", "");
  navigate("#reports");
});

// ===== AFILIADOS =====

document.getElementById("menu-affiliates")?.addEventListener("click", () => {
  closeMenu();
  navigate("#affiliates");
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
    document.getElementById("affiliate-commission-rate").innerText = `${data.commissionRate}%`;
    document.getElementById("affiliate-volume").innerText = formatBRL(data.totalVolumeCents);
    document.getElementById("affiliate-commission-value").innerText = formatDePix(data.pendingCommissionCents);

    renderReferrals(data.referrals);
    renderPayments(data.payments);

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

// Payments info modal
document.getElementById("affiliate-payments-info")?.addEventListener("click", () => {
  document.getElementById("payments-info-modal")?.classList.remove("hidden");
});
document.getElementById("close-payments-info")?.addEventListener("click", () => {
  document.getElementById("payments-info-modal")?.classList.add("hidden");
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

document.getElementById("btn-request-report")?.addEventListener("click", async () => {
  const dataInicio = document.getElementById("report-start").value;
  const dataFim = document.getElementById("report-end").value;

  setMsg("report-msg", "");

  if (!dataInicio || !dataFim) {
    setMsg("report-msg", "Selecione as datas de início e fim");
    return;
  }

  const start = new Date(dataInicio);
  const end = new Date(dataFim);

  if (end < start) {
    setMsg("report-msg", "A data final deve ser posterior à data inicial");
    return;
  }

  const diffDays = (end - start) / (1000 * 60 * 60 * 24);
  if (diffDays > 366) {
    setMsg("report-msg", "O intervalo máximo é de 1 ano");
    return;
  }

  const btn = document.getElementById("btn-request-report");
  btn.disabled = true;
  btn.innerText = "Solicitando…";

  try {
    const res = await apiFetch("/api/reports", {
      method: "POST",
      body: JSON.stringify({ tipo: reportType, dataInicio, dataFim })
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("report-msg", data?.response?.errorMessage || "Erro ao solicitar relatório");
      return;
    }

    const user = getUser();
    const email = user?.email || "seu email";
    setMsg("report-msg", `Relatório será enviado para ${email}. Pode levar alguns minutos.`, true);
  } catch (e) {
    setMsg("report-msg", e.message || "Sem conexão. Verifique sua internet e tente novamente.");
  } finally {
    btn.disabled = false;
    btn.innerText = "Solicitar relatório";
  }
});

// =========================================
// TRANSACTIONS
// =========================================

const DEPOSIT_STATUS_LABELS = {
  pending: "Pendente", depix_sent: "Concluído", under_review: "Em análise",
  canceled: "Cancelado", error: "Erro", refunded: "Reembolsado",
  expired: "Expirado", pending_pix2fa: "Aguardando 2FA", delayed: "Atrasado"
};

const WITHDRAW_STATUS_LABELS = {
  unsent: "Aguardando", sending: "Enviando", sent: "Enviado",
  error: "Erro", cancelled: "Cancelado", refunded: "Reembolsado"
};

const NON_TERMINAL_STATUSES = new Set([
  "pending", "sending", "unsent", "under_review", "pending_pix2fa", "delayed"
]);

function statusColor(status) {
  if (["depix_sent", "sent"].includes(status)) return "status-green";
  if (["pending", "sending", "pending_pix2fa"].includes(status)) return "status-yellow";
  if (["under_review", "delayed"].includes(status)) return "status-orange";
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
  const details = [];

  if (tx.payer_name) {
    details.push({ label: "Pagador", value: escapeHtml(tx.payer_name), full: tx.payer_name });
  }
  if (tx.chave_pix) {
    details.push({ label: "Chave PIX", value: escapeHtml(abbreviateHash(tx.chave_pix, 10, 4)), full: tx.chave_pix, mono: true });
  }
  if (tx.customer_message) {
    details.push({ label: "Msg", value: escapeHtml(tx.customer_message), full: tx.customer_message });
  }
  if (tx.endereco_liquid) {
    details.push({ label: "Endereço", value: escapeHtml(abbreviateHash(tx.endereco_liquid)), full: tx.endereco_liquid, mono: true });
  }
  if (tx.blockchain_tx_id) {
    details.push({ label: "TXID", value: escapeHtml(abbreviateHash(tx.blockchain_tx_id)), full: tx.blockchain_tx_id, mono: true });
  }

  if (details.length === 0) return "";

  const copyIcon = '<svg class="copy-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const items = details.map(d => {
    const monoClass = d.mono ? " mono" : "";
    return `<span class="transaction-detail copyable${monoClass}" title="Copiar: ${escapeHtml(d.full)}" data-copy="${escapeHtml(d.full)}"><span class="transaction-detail-label">${d.label}:</span> <span class="transaction-detail-value">${d.value}</span>${copyIcon}</span>`;
  }).join("");

  return `<div class="transaction-details">${items}</div>`;
}

let allTransactions = [];
let filteredTransactions = [];
let displayedCount = 0;
const PAGE_SIZE = 50;

async function loadTransactions() {
  const loading = document.getElementById("transactions-loading");

  loading.classList.remove("hidden");
  setMsg("transactions-msg", "");
  document.getElementById("transactions-list").innerHTML = "";
  document.getElementById("transactions-empty").classList.add("hidden");
  document.getElementById("transactions-load-more").classList.add("hidden");
  document.getElementById("transactions-count").classList.add("hidden");

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
  document.getElementById("transactions-list").innerHTML = "";
  renderNextPage();
}

function renderNextPage() {
  const list = document.getElementById("transactions-list");
  const empty = document.getElementById("transactions-empty");
  const loadMore = document.getElementById("transactions-load-more");
  const countEl = document.getElementById("transactions-count");

  const nextBatch = filteredTransactions.slice(displayedCount, displayedCount + PAGE_SIZE);

  if (displayedCount === 0 && nextBatch.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    loadMore.classList.add("hidden");
    countEl.classList.add("hidden");
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

  if (displayedCount === 0) {
    list.innerHTML = html;
  } else {
    list.insertAdjacentHTML("beforeend", html);
  }

  displayedCount += nextBatch.length;

  const hasMore = displayedCount < filteredTransactions.length;
  loadMore.classList.toggle("hidden", !hasMore);

  countEl.innerText = `Mostrando ${displayedCount} de ${filteredTransactions.length}`;
  countEl.classList.remove("hidden");

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
}

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

// Extrato: copy detail value on click
document.getElementById("transactions-list")?.addEventListener("click", (e) => {
  const el = e.target.closest(".transaction-detail.copyable");
  if (!el) return;
  const text = el.dataset.copy;
  if (text && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      el.classList.add("copied");
      showToast("Copiado!");
      setTimeout(() => el.classList.remove("copied"), 1500);
    });
  }
});

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
document.getElementById("btn-load-more")?.addEventListener("click", renderNextPage);

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
  document.getElementById("resultado")?.classList.add("hidden");
  document.getElementById("formDeposito")?.classList.remove("hidden");
  document.getElementById("valor").value = "";
  setMsg("mensagem", "");
  // Reset saque state
  document.getElementById("resultadoSaque")?.classList.add("hidden");
  document.getElementById("formSaque")?.classList.remove("hidden");
  document.getElementById("saqueQr")?.classList.add("hidden");
  document.getElementById("saqueWarning")?.classList.add("hidden");
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
route("#no-address", () => {});
route("#faq", () => {});
route("#transactions", () => { loadTransactions(); });
route("#forgot-password", () => { setMsg("forgot-msg", ""); });
route("#reset-password", () => { setMsg("reset-msg", ""); });

route("#reports", () => {
  const fmt = d => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  document.getElementById("report-end").value = fmt(now);
  document.getElementById("report-start").value = fmt(thirtyDaysAgo);
});

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

// ===== Initialize =====
const isPWA = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;

const hashBase = window.location.hash.split("?")[0];
if (isPWA || (hashBase && hashBase !== "#" && hashBase !== "#landing")) {
  goToAppropriateScreen();
} else if (isLoggedIn()) {
  goToAppropriateScreen();
}
// else: no hash + not logged in + browser mode → router shows #landing
initRouter();
