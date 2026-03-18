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

const MIN_VALOR_CENTS = 500;      // R$ 5,00
const MAX_VALOR_CENTS = 300000;   // R$ 3.000,00

let qrCopyPaste = "";
let deferredPrompt = null;
let modoSaque = false;           // false = depósito, true = saque
let valorModeIsPix = false;      // false = depositAmount (Depix), true = payoutAmount (PIX)
let saqueDepositAddress = "";    // endereço completo para cópia

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
   DETECTAR SE JÁ ESTÁ INSTALADO
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

/* Restaurar endereço salvo */
const savedEndereco = localStorage.getItem("depix-endereco");
if (savedEndereco) enderecoInput.value = savedEndereco;

/* Restaurar chave PIX salva */
const savedPixKey = localStorage.getItem("depix-pixkey");
if (savedPixKey) pixKeyInput.value = savedPixKey;

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
  if (cents < MIN_VALOR_CENTS) {
    return "O valor mínimo é R$ 5,00";
  }
  if (cents > MAX_VALOR_CENTS) {
    return "O valor máximo é R$ 3.000,00";
  }
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
    const res = await fetch("https://depix-backend.vercel.app/api/depix", {
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
   GERAR SAQUE
====================== */
btnSacar.onclick = async () => {
  mensagemSaque.innerText = "";

  if (!valorSaqueInput.value || !pixKeyInput.value.trim()) {
    mensagemSaque.innerText = "Preencha todos os campos";
    return;
  }

  const valorCents = toCents(valorSaqueInput.value);

  const erroValor = isValorValidoEmCentavos(valorCents);
  if (erroValor) {
    mensagemSaque.innerText = erroValor;
    return;
  }

  // Salvar chave PIX para conveniência
  localStorage.setItem("depix-pixkey", pixKeyInput.value.trim());

  btnSacar.disabled = true;
  loadingSaque.classList.remove("hidden");

  try {
    const body = {
      pixKey: pixKeyInput.value.trim()
    };

    if (valorModeIsPix) {
      body.payoutAmountInCents = valorCents;
    } else {
      body.depositAmountInCents = valorCents;
    }

    const res = await fetch("https://depix-backend.vercel.app/api/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": getDeviceId()
      },
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

    // Gerar QR code do endereço Liquid para a SideSwap ler
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
  location.reload();
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
