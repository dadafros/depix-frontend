const API = "https://depix-backend.vercel.app";

/* ======================
   ELEMENTOS — Auth
====================== */
const telaLogin = document.getElementById("telaLogin");
const telaCadastro = document.getElementById("telaCadastro");
const telaVerificacao = document.getElementById("telaVerificacao");
const telaApp = document.getElementById("telaApp");

const loginUsuario = document.getElementById("loginUsuario");
const loginSenha = document.getElementById("loginSenha");
const btnLogin = document.getElementById("btnLogin");
const mensagemLogin = document.getElementById("mensagemLogin");
const loadingLogin = document.getElementById("loadingLogin");
const linkCadastro = document.getElementById("linkCadastro");

const cadNome = document.getElementById("cadNome");
const cadEmail = document.getElementById("cadEmail");
const cadWhatsapp = document.getElementById("cadWhatsapp");
const cadUsuario = document.getElementById("cadUsuario");
const cadSenha = document.getElementById("cadSenha");
const btnCadastro = document.getElementById("btnCadastro");
const mensagemCadastro = document.getElementById("mensagemCadastro");
const loadingCadastro = document.getElementById("loadingCadastro");
const linkLogin = document.getElementById("linkLogin");

const verifCodigo = document.getElementById("verifCodigo");
const btnVerificar = document.getElementById("btnVerificar");
const btnReenviar = document.getElementById("btnReenviar");
const mensagemVerificacao = document.getElementById("mensagemVerificacao");
const loadingVerificacao = document.getElementById("loadingVerificacao");
const loadingReenviar = document.getElementById("loadingReenviar");
const linkVoltarLogin = document.getElementById("linkVoltarLogin");

const headerUsuario = document.getElementById("headerUsuario");
const btnLogout = document.getElementById("btnLogout");

/* ======================
   ELEMENTOS — Depósito
====================== */
const valorInput = document.getElementById("valor");
const enderecoInput = document.getElementById("endereco");
const btnGerar = document.getElementById("btnGerar");
const btnCopy = document.getElementById("btnCopy");
const btnReset = document.getElementById("btnReset");

const loading = document.getElementById("loading");
const resultado = document.getElementById("resultado");
const mensagem = document.getElementById("mensagem");
const qrImage = document.getElementById("qrImage");
const qrId = document.getElementById("qrId");

/* ======================
   ELEMENTOS — Saque
====================== */
const valorSaqueInput = document.getElementById("valorSaque");
const pixKeyInput = document.getElementById("pixKey");
const btnSacar = document.getElementById("btnSacar");
const btnCopyAddress = document.getElementById("btnCopyAddress");
const btnNovoSaque = document.getElementById("btnNovoSaque");

const loadingSaque = document.getElementById("loadingSaque");
const resultadoSaque = document.getElementById("resultadoSaque");
const formSaque = document.getElementById("formSaque");
const mensagemSaque = document.getElementById("mensagemSaque");
const saqueDepositAmount = document.getElementById("saqueDepositAmount");
const saquePayoutAmount = document.getElementById("saquePayoutAmount");
const saqueAddress = document.getElementById("saqueAddress");
const saqueQr = document.getElementById("saqueQr");

/* ======================
   ELEMENTOS — Switches
====================== */
const switchTrack = document.getElementById("switchTrack");
const switchText = document.getElementById("switchText");
const telaDeposito = document.getElementById("telaDeposito");
const telaSaque = document.getElementById("telaSaque");

const valorModeTrack = document.getElementById("valorModeTrack");
const valorModeText = document.getElementById("valorModeText");

/* PWA */
const installBtn = document.getElementById("installBtn");
const modal = document.getElementById("installModal");
const closeModal = document.getElementById("closeModal");

const MIN_VALOR_CENTS = 500;
const MAX_VALOR_CENTS = 300000;

let qrCopyPaste = "";
let deferredPrompt = null;
let modoSaque = false;
let valorModeIsPix = false;
let saqueDepositAddress = "";
let pendingVerifUsuario = "";   // username aguardando verificação

/* ======================
   AUTH — Token management
====================== */
function getAuth() {
  try {
    const raw = localStorage.getItem("depix-auth");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setAuth(data) {
  localStorage.setItem("depix-auth", JSON.stringify(data));
}

function clearAuth() {
  localStorage.removeItem("depix-auth");
}

function getAccessToken() {
  const auth = getAuth();
  return auth?.token || null;
}

async function refreshAccessToken() {
  const auth = getAuth();
  if (!auth?.refreshToken) return false;

  try {
    const res = await fetch(API + "/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: auth.refreshToken })
    });

    if (!res.ok) {
      clearAuth();
      return false;
    }

    const data = await res.json();
    setAuth({
      token: data.token,
      refreshToken: data.refreshToken,
      user: auth.user
    });
    return true;
  } catch {
    return false;
  }
}

async function authFetch(url, opts = {}) {
  const token = getAccessToken();
  if (!token) throw new Error("Faça login para continuar");

  opts.headers = {
    ...opts.headers,
    "Authorization": "Bearer " + token,
    "X-Device-Id": getDeviceId()
  };

  let res = await fetch(url, opts);

  // Se 401, tenta refresh
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      opts.headers["Authorization"] = "Bearer " + getAccessToken();
      res = await fetch(url, opts);
    } else {
      clearAuth();
      showScreen("login");
      throw new Error("Sessão expirada. Faça login novamente.");
    }
  }

  return res;
}

/* ======================
   DEVICE ID (rate limit)
====================== */
function getDeviceId() {
  let id = localStorage.getItem("depix-device-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("depix-device-id", id);
  }
  return id;
}

const ALLOWED_QR_HOSTS = ["depix.eulen.app", "eulen.app", "api.qrserver.com"];

function isAllowedImageUrl(url) {
  if (typeof url !== "string") return false;
  if (url.startsWith("data:image/")) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_QR_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))
    );
  } catch {
    return false;
  }
}

/* ======================
   SCREEN MANAGEMENT
====================== */
function showScreen(name) {
  telaLogin.classList.add("hidden");
  telaCadastro.classList.add("hidden");
  telaVerificacao.classList.add("hidden");
  telaApp.classList.add("hidden");

  // Limpar mensagens ao trocar de tela
  mensagemLogin.innerText = "";
  mensagemCadastro.innerText = "";
  mensagemVerificacao.innerText = "";

  if (name === "login") telaLogin.classList.remove("hidden");
  else if (name === "cadastro") telaCadastro.classList.remove("hidden");
  else if (name === "verificacao") telaVerificacao.classList.remove("hidden");
  else if (name === "app") {
    telaApp.classList.remove("hidden");
    const auth = getAuth();
    if (auth?.user) {
      headerUsuario.innerText = auth.user.usuario;
    }
  }
}

/* ======================
   INIT — Verificar se já está logado
====================== */
function init() {
  const auth = getAuth();
  if (auth?.token) {
    showScreen("app");
  } else {
    showScreen("login");
  }
}

/* ======================
   PWA
====================== */
function isAppInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

if (isAppInstalled()) {
  installBtn.style.display = "none";
}

/* Restaurar campos salvos */
const savedEndereco = localStorage.getItem("depix-endereco");
if (savedEndereco) enderecoInput.value = savedEndereco;

const savedPixKey = localStorage.getItem("depix-pixkey");
if (savedPixKey) pixKeyInput.value = savedPixKey;

/* ======================
   AUTH — Login
====================== */
btnLogin.onclick = async () => {
  mensagemLogin.innerText = "";
  mensagemLogin.classList.remove("success");

  const usuario = loginUsuario.value.trim();
  const senha = loginSenha.value;

  if (!usuario || !senha) {
    mensagemLogin.innerText = "Preencha todos os campos";
    return;
  }

  btnLogin.disabled = true;
  loadingLogin.classList.remove("hidden");

  try {
    const res = await fetch(API + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha })
    });

    const data = await res.json();

    if (res.status === 403 && data.usuario) {
      // Email não verificado — ir para tela de verificação
      pendingVerifUsuario = data.usuario;
      showScreen("verificacao");
      return;
    }

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    if (!data.token) {
      throw new Error("Resposta inesperada do servidor");
    }

    setAuth({
      token: data.token,
      refreshToken: data.refreshToken,
      user: data.user
    });

    loginUsuario.value = "";
    loginSenha.value = "";
    showScreen("app");

  } catch (e) {
    mensagemLogin.innerText = e.message || "Erro ao fazer login";
  } finally {
    loadingLogin.classList.add("hidden");
    btnLogin.disabled = false;
  }
};

/* ======================
   AUTH — Cadastro
====================== */
btnCadastro.onclick = async () => {
  mensagemCadastro.innerText = "";
  mensagemCadastro.classList.remove("success");

  const nome = cadNome.value.trim();
  const email = cadEmail.value.trim();
  const whatsapp = cadWhatsapp.value.trim();
  const usuario = cadUsuario.value.trim();
  const senha = cadSenha.value;

  if (!nome || !email || !whatsapp || !usuario || !senha) {
    mensagemCadastro.innerText = "Preencha todos os campos";
    return;
  }

  if (senha.length < 8) {
    mensagemCadastro.innerText = "Senha deve ter no mínimo 8 caracteres";
    return;
  }

  btnCadastro.disabled = true;
  loadingCadastro.classList.remove("hidden");

  try {
    const res = await fetch(API + "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, email, whatsapp, usuario, senha })
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    // Sucesso — ir para verificação
    pendingVerifUsuario = data.usuario || usuario.toLowerCase();
    showScreen("verificacao");

  } catch (e) {
    mensagemCadastro.innerText = e.message || "Erro ao criar conta";
  } finally {
    loadingCadastro.classList.add("hidden");
    btnCadastro.disabled = false;
  }
};

/* ======================
   AUTH — Verificação de email
====================== */
btnVerificar.onclick = async () => {
  mensagemVerificacao.innerText = "";
  mensagemVerificacao.classList.remove("success");

  const codigo = verifCodigo.value.trim();

  if (!codigo || !/^\d{6}$/.test(codigo)) {
    mensagemVerificacao.innerText = "Digite o código de 6 dígitos";
    return;
  }

  btnVerificar.disabled = true;
  loadingVerificacao.classList.remove("hidden");

  try {
    const res = await fetch(API + "/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: pendingVerifUsuario, codigo })
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    // Sucesso — voltar para login com mensagem de sucesso
    verifCodigo.value = "";
    showScreen("login");
    mensagemLogin.classList.add("success");
    mensagemLogin.innerText = "Email verificado! Agora faça login.";

  } catch (e) {
    mensagemVerificacao.innerText = e.message || "Erro ao verificar código";
  } finally {
    loadingVerificacao.classList.add("hidden");
    btnVerificar.disabled = false;
  }
};

/* ======================
   AUTH — Reenviar código
====================== */
btnReenviar.onclick = async () => {
  mensagemVerificacao.innerText = "";
  mensagemVerificacao.classList.remove("success");

  btnReenviar.disabled = true;
  loadingReenviar.classList.remove("hidden");

  try {
    const res = await fetch(API + "/api/auth/resend-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: pendingVerifUsuario })
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    mensagemVerificacao.classList.add("success");
    mensagemVerificacao.innerText = "Novo código enviado! Verifique seu email.";

  } catch (e) {
    mensagemVerificacao.innerText = e.message || "Erro ao reenviar código";
  } finally {
    loadingReenviar.classList.add("hidden");
    btnReenviar.disabled = false;
  }
};

/* ======================
   AUTH — Logout
====================== */
btnLogout.onclick = async (e) => {
  e.preventDefault();
  const auth = getAuth();

  try {
    await fetch(API + "/api/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + (auth?.token || "")
      },
      body: JSON.stringify({ refreshToken: auth?.refreshToken || "" })
    });
  } catch {
    // Ignora erros de logout
  }

  clearAuth();
  showScreen("login");
};

/* ======================
   AUTH — Navegação entre telas
====================== */
linkCadastro.onclick = (e) => { e.preventDefault(); showScreen("cadastro"); };
linkLogin.onclick = (e) => { e.preventDefault(); showScreen("login"); };
linkVoltarLogin.onclick = (e) => { e.preventDefault(); showScreen("login"); };

/* ======================
   SWITCH — Depósito / Saque
====================== */
switchTrack.onclick = () => {
  modoSaque = !modoSaque;

  if (modoSaque) {
    switchTrack.classList.add("active");
    switchText.innerText = "Novo pagamento";
    telaDeposito.classList.add("hidden");
    telaSaque.classList.remove("hidden");
  } else {
    switchTrack.classList.remove("active");
    switchText.innerText = "Sacar Depix";
    telaSaque.classList.add("hidden");
    telaDeposito.classList.remove("hidden");
  }
};

/* ======================
   SWITCH — Modo de valor (Depix / PIX)
====================== */
valorModeTrack.onclick = () => {
  valorModeIsPix = !valorModeIsPix;

  if (valorModeIsPix) {
    valorModeTrack.classList.add("active");
    valorModeText.innerText = "Valor em PIX (você recebe)";
  } else {
    valorModeTrack.classList.remove("active");
    valorModeText.innerText = "Valor em Depix (você envia)";
  }
};

/* ======================
   FORMATAÇÃO R$
====================== */
function formatCurrencyInput(input) {
  input.addEventListener("input", () => {
    let v = input.value.replace(/\D/g, "");
    if (!v) {
      input.value = "";
      return;
    }
    v = (v / 100).toFixed(2).replace(".", ",");
    input.value = "R$ " + v;
  });
}

formatCurrencyInput(valorInput);
formatCurrencyInput(valorSaqueInput);

function isValorValidoEmCentavos(cents) {
  if (cents < MIN_VALOR_CENTS) return "O valor mínimo é R$ 5,00";
  if (cents > MAX_VALOR_CENTS) return "O valor máximo é R$ 3.000,00";
  return null;
}

const toCents = v =>
  Math.round(
    parseFloat(v.replace("R$", "").replace(/\./g, "").replace(",", "."))
    * 100
  );

function formatBRL(cents) {
  return "R$ " + (cents / 100).toFixed(2).replace(".", ",");
}

function shortenAddress(addr) {
  if (!addr || addr.length <= 16) return addr;
  return addr.slice(0, 8) + "…" + addr.slice(-8);
}

/* ======================
   GERAR QR CODE (Depósito)
====================== */
btnGerar.onclick = async () => {
  mensagem.innerText = "";

  if (!valorInput.value || !enderecoInput.value.trim()) {
    mensagem.innerText = "Preencha todos os campos";
    return;
  }

  const valorCents = toCents(valorInput.value);
  const erroValor = isValorValidoEmCentavos(valorCents);
  if (erroValor) {
    mensagem.innerText = erroValor;
    return;
  }

  btnGerar.disabled = true;
  loading.classList.remove("hidden");

  try {
    const res = await fetch(API + "/api/depix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": getDeviceId()
      },
      body: JSON.stringify({
        amountInCents: valorCents,
        depixAddress: enderecoInput.value.trim()
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
    qrImage.src = data.response.qrImageUrl;
    qrId.innerText = "ID: " + data.response.id;
    resultado.classList.remove("hidden");

  } catch (e) {
    mensagem.innerText = e.message || "Erro ao gerar QR Code";
  } finally {
    loading.classList.add("hidden");
    btnGerar.disabled = false;
  }
};

/* ======================
   GERAR SAQUE (autenticado)
====================== */
btnSacar.onclick = async () => {
  mensagemSaque.innerText = "";

  if (!valorSaqueInput.value || !pixKeyInput.value.trim()) {
    mensagemSaque.innerText = "Preencha todos os campos";
    return;
  }

  if (!enderecoInput.value.trim()) {
    mensagemSaque.innerText = "Preencha o Endereço Liquid na tela de pagamento antes de sacar";
    return;
  }

  const valorCents = toCents(valorSaqueInput.value);
  const erroValor = isValorValidoEmCentavos(valorCents);
  if (erroValor) {
    mensagemSaque.innerText = erroValor;
    return;
  }

  localStorage.setItem("depix-pixkey", pixKeyInput.value.trim());

  btnSacar.disabled = true;
  loadingSaque.classList.remove("hidden");

  try {
    const body = {
      pixKey: pixKeyInput.value.trim(),
      depixAddress: enderecoInput.value.trim()
    };

    if (valorModeIsPix) {
      body.payoutAmountInCents = valorCents;
    } else {
      body.depositAmountInCents = valorCents;
    }

    const res = await authFetch(API + "/api/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    const r = data.response;

    saqueDepositAmount.innerText = formatBRL(r.depositAmountInCents);
    saquePayoutAmount.innerText = formatBRL(r.payoutAmountInCents);
    saqueDepositAddress = r.depositAddress;
    saqueAddress.innerText = shortenAddress(r.depositAddress);

    const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=" + encodeURIComponent(r.depositAddress);
    saqueQr.src = qrUrl;
    saqueQr.classList.remove("hidden");

    formSaque.classList.add("hidden");
    resultadoSaque.classList.remove("hidden");

  } catch (e) {
    mensagemSaque.innerText = e.message || "Erro ao processar saque";
  } finally {
    loadingSaque.classList.add("hidden");
    btnSacar.disabled = false;
  }
};

/* ======================
   COPIAR / RESET
====================== */
const toast = document.getElementById("toast");

function showToast(text) {
  toast.innerText = text;
  toast.classList.remove("hidden");
  toast.classList.add("show");

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => {
      toast.classList.add("hidden");
    }, 300);
  }, 2000);
}

btnCopy.onclick = async () => {
  try {
    await navigator.clipboard.writeText(qrCopyPaste);
    showToast("Código copiado. Cole no app do seu banco.");
  } catch {
    showToast("Não foi possível copiar. Copie manualmente.");
  }
};

btnReset.onclick = () => {
  localStorage.setItem("depix-endereco", enderecoInput.value.trim());
  resultado.classList.add("hidden");
  valorInput.value = "";
  mensagem.innerText = "";
};

/* ======================
   COPIAR ENDEREÇO / NOVO SAQUE
====================== */
btnCopyAddress.onclick = async () => {
  try {
    await navigator.clipboard.writeText(saqueDepositAddress);
    showToast("Endereço copiado.");
  } catch {
    showToast("Não foi possível copiar. Copie manualmente.");
  }
};

btnNovoSaque.onclick = () => {
  resultadoSaque.classList.add("hidden");
  formSaque.classList.remove("hidden");
  saqueQr.classList.add("hidden");
  valorSaqueInput.value = "";
  mensagemSaque.innerText = "";
};

/* ======================
   PWA INSTALL
====================== */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
});

installBtn.onclick = async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.style.display = "none";
    return;
  }
  modal.classList.remove("hidden");
};

window.addEventListener("appinstalled", () => {
  installBtn.style.display = "none";
});

closeModal.onclick = () => {
  modal.classList.add("hidden");
};

/* ======================
   SUBMIT COM ENTER
====================== */
loginSenha.addEventListener("keydown", e => { if (e.key === "Enter") btnLogin.click(); });
loginUsuario.addEventListener("keydown", e => { if (e.key === "Enter") loginSenha.focus(); });
cadSenha.addEventListener("keydown", e => { if (e.key === "Enter") btnCadastro.click(); });
verifCodigo.addEventListener("keydown", e => { if (e.key === "Enter") btnVerificar.click(); });

/* ======================
   INICIAR APP
====================== */
init();
