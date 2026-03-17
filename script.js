/* ======================
   ELEMENTOS
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

/* PWA */
const installBtn = document.getElementById("installBtn");
const modal = document.getElementById("installModal");
const closeModal = document.getElementById("closeModal");

const MIN_VALOR_CENTS = 500;      // R$ 5,00
const MAX_VALOR_CENTS = 300000;  // R$ 3.000,00

let qrCopyPaste = "";
let deferredPrompt = null;

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

const ALLOWED_QR_HOSTS = ["depix.eulen.app", "eulen.app"];

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

/* Esconder botão se já estiver instalado */
if (isAppInstalled()) {
  installBtn.style.display = "none";
}

/* Restaurar endereço salvo */
const savedEndereco = localStorage.getItem("depix-endereco");
if (savedEndereco) enderecoInput.value = savedEndereco;

/* ======================
   FORMATAÇÃO R$
====================== */
valorInput.addEventListener("input", () => {
  let v = valorInput.value.replace(/\D/g, "");
  if (!v) {
    valorInput.value = "";
    return;
  }
  v = (v / 100).toFixed(2).replace(".", ",");
  valorInput.value = "R$ " + v;
});

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

/* ======================
   GERAR QR CODE
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
   PWA INSTALL
====================== */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
});

/* Clique no botão instalar */
installBtn.onclick = async () => {
  // Tentativa de instalação automática
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;

    installBtn.style.display = "none"; // esconde após instalar
    return;
  }

  // Fallback (Safari / iOS)
  modal.classList.remove("hidden");
};

/* Evento disparado quando instala fora do botão */
window.addEventListener("appinstalled", () => {
  installBtn.style.display = "none";
});

/* Fechar modal */
closeModal.onclick = () => {
  modal.classList.add("hidden");
};
