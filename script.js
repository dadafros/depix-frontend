// DePix — Main entry point (ES module)

import { route, navigate, initRouter } from "./router.js";
import { isLoggedIn, setAuth, clearAuth, getUser, getRefreshToken } from "./auth.js";
import { apiFetch } from "./api.js";
import {
  getAddresses, addAddress, removeAddress,
  getSelectedAddress, setSelectedAddress,
  abbreviateAddress, hasAddresses
} from "./addresses.js";
import { ALLOWED_QR_HOSTS, isAllowedImageUrl, toCents, formatBRL } from "./utils.js";
import { validateLiquidAddress, validatePhone } from "./validation.js";
import { showToast, setMsg, goToAppropriateScreen as _goToAppropriateScreen } from "./script-helpers.js";

// ===== Constants =====
const MIN_VALOR_CENTS = 500;
const MAX_VALOR_CENTS = 300000;

let qrCopyPaste = "";
let deferredPrompt = null;
let pendingAddressChange = "";
let reportType = "";
let modoSaque = false;
let valorModeIsPix = false;
let saqueDepositAddress = "";

// Register service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js");
}

// ===== Utility functions =====
// showToast and setMsg are imported from script-helpers.js

function formatCurrencyInput(input) {
  if (!input) return;
  input.addEventListener("input", () => {
    let v = input.value.replace(/\D/g, "");
    if (!v) { input.value = ""; return; }
    v = (v / 100).toFixed(2).replace(".", ",");
    input.value = "R$ " + v;
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
  document.getElementById("installModal")?.classList.remove("hidden");
});

document.getElementById("closeModal")?.addEventListener("click", () => {
  document.getElementById("installModal")?.classList.add("hidden");
});

if (isAppInstalled()) {
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "none";
}

// =========================================
// LOGIN
// =========================================

document.getElementById("btn-login")?.addEventListener("click", async () => {
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
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ usuario, senha })
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
});

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
    const res = await apiFetch("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ nome, email, whatsapp, usuario, senha })
    });
    const data = await res.json();

    if (!res.ok) {
      setMsg("register-msg", data?.response?.errorMessage || "Erro ao criar conta");
      return;
    }

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
    const res = await apiFetch("/api/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ usuario })
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
    const res = await apiFetch("/api/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ usuario })
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
    const res = await apiFetch("/api/auth/forgot-password", {
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
    const res = await apiFetch("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ identificador, codigo, novaSenha })
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
    const res = await apiFetch("/api/auth/resend-reset-code", {
      method: "POST",
      body: JSON.stringify({ identificador })
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

document.getElementById("switchTrack")?.addEventListener("click", () => {
  modoSaque = !modoSaque;
  const track = document.getElementById("switchTrack");
  const text = document.getElementById("switchText");

  if (modoSaque) {
    track.classList.add("active");
    text.innerText = "Voltar para recebimento";
    document.getElementById("telaDeposito").classList.add("hidden");
    document.getElementById("telaSaque").classList.remove("hidden");
  } else {
    track.classList.remove("active");
    text.innerText = "Transferir para conta";
    document.getElementById("telaSaque").classList.add("hidden");
    document.getElementById("telaDeposito").classList.remove("hidden");
  }
});

document.getElementById("valorModeTrack")?.addEventListener("click", () => {
  valorModeIsPix = !valorModeIsPix;
  const track = document.getElementById("valorModeTrack");
  const text = document.getElementById("valorModeText");

  if (valorModeIsPix) {
    track.classList.add("active");
    text.innerText = "Valor que você recebe";
  } else {
    track.classList.remove("active");
    text.innerText = "Valor que você envia";
  }
});

// =========================================
// HOME — Depósito (QR Code generation)
// =========================================

formatCurrencyInput(document.getElementById("valor"));
formatCurrencyInput(document.getElementById("valorSaque"));

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
    setMsg("mensagem", "O valor máximo é R$ 3.000,00");
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
    document.getElementById("qrImage").src = data.response.qrImageUrl;
    document.getElementById("qrId").innerText = "ID: " + data.response.id;
    document.getElementById("resultado").classList.remove("hidden");

  } catch (e) {
    setMsg("mensagem", e.message || "Não foi possível gerar o código. Tente novamente.");
  } finally {
    document.getElementById("loading").classList.add("hidden");
    btn.disabled = false;
    btn.innerText = "Gerar código de pagamento";
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
    setMsg("mensagemSaque", "O valor máximo é R$ 3.000,00");
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

    document.getElementById("saqueDepositAmount").innerText = formatBRL(r.depositAmountInCents);
    document.getElementById("saquePayoutAmount").innerText = formatBRL(r.payoutAmountInCents);
    saqueDepositAddress = r.depositAddress;
    const addrShort = r.depositAddress.length > 16
      ? r.depositAddress.slice(0, 8) + "…" + r.depositAddress.slice(-8)
      : r.depositAddress;
    document.getElementById("saqueAddress").innerText = addrShort;

    // Generate QR code for the Liquid address
    const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(r.depositAddress);
    const saqueQr = document.getElementById("saqueQr");
    saqueQr.src = qrUrl;
    saqueQr.classList.remove("hidden");

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
document.getElementById("menu-logout")?.addEventListener("click", async () => {
  closeMenu();
  try {
    const refreshToken = getRefreshToken();
    await apiFetch("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken })
    });
  } catch { /* ignore */ }
  clearAuth();
  // Clear password field on logout so it doesn't persist
  const loginSenha = document.getElementById("login-senha");
  if (loginSenha) loginSenha.value = "";
  navigate("#login");
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
    const res = await apiFetch("/api/support/contact", {
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
    return `
      <div class="addr-list-item${isSelected ? " selected" : ""}" data-addr="${addr}">
        <div class="addr-radio"></div>
        <span class="addr-text" title="${addr}">${abbreviateAddress(addr)}</span>
        <button class="addr-delete" data-delete="${addr}" title="Remover">🗑</button>
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
  document.getElementById("new-addr-input").value = "";
  setMsg("add-addr-msg", "");
  document.getElementById("add-addr-modal").classList.remove("hidden");
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
// ROUTING SETUP
// =========================================

function goToAppropriateScreen() {
  _goToAppropriateScreen({ isLoggedIn, hasAddresses, navigate });
}

route("#home", () => {
  updateAddrDisplay();
  document.getElementById("resultado")?.classList.add("hidden");
  document.getElementById("valor").value = "";
  setMsg("mensagem", "");
  // Reset saque state
  document.getElementById("resultadoSaque")?.classList.add("hidden");
  document.getElementById("formSaque")?.classList.remove("hidden");
  document.getElementById("saqueQr")?.classList.add("hidden");
});

route("#login", () => {
  if (isLoggedIn()) goToAppropriateScreen();
  // Always clear password field when showing login
  const loginSenha = document.getElementById("login-senha");
  if (loginSenha) loginSenha.value = "";
});

route("#register", () => { setMsg("register-msg", ""); });
route("#verify", () => {
  setMsg("verify-msg", "");
  document.getElementById("verify-code").value = "";
  const hasUsuario = !!sessionStorage.getItem("depix-verify-usuario");
  const grupoUsuario = document.getElementById("verify-usuario-group");
  if (grupoUsuario) {
    grupoUsuario.classList.toggle("hidden", hasUsuario);
  }
});
route("#no-address", () => {});
route("#faq", () => {});
route("#forgot-password", () => { setMsg("forgot-msg", ""); });
route("#reset-password", () => { setMsg("reset-msg", ""); });

route("#reports", () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  document.getElementById("report-end").value = now.toISOString().split("T")[0];
  document.getElementById("report-start").value = thirtyDaysAgo.toISOString().split("T")[0];
});

// ===== Initialize =====
goToAppropriateScreen();
initRouter();
