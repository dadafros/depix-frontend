const valorInput = document.getElementById("valor");
const enderecoInput = document.getElementById("endereco");

const btnGerar = document.getElementById("btnGerar");
const btnCopy = document.getElementById("btnCopy");
const btnReset = document.getElementById("btnReset");

const formEl = document.getElementById("form");
const loadingEl = document.getElementById("loading");
const resultadoEl = document.getElementById("resultado");
const qrImageEl = document.getElementById("qrImage");
const qrIdEl = document.getElementById("qrId");
const mensagemEl = document.getElementById("mensagem");

let qrCopyPaste = "";
let emAndamento = false;

/* ===== Formatação R$ ===== */
valorInput.addEventListener("input", () => {
  let v = valorInput.value.replace(/\D/g, "");
  if (!v) return (valorInput.value = "");
  v = (v / 100).toFixed(2).replace(".", ",");
  v = v.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  valorInput.value = "R$ " + v;
});

function centavos(v) {
  return Math.round(
    parseFloat(v.replace("R$", "").replace(/\./g, "").replace(",", ".")) * 100
  );
}

/* ===== Gerar QR ===== */
btnGerar.onclick = async () => {
  if (emAndamento) return;

  mensagemEl.innerText = "";

  const valor = valorInput.value;
  const endereco = enderecoInput.value.trim();

  if (!valor || !endereco) {
    mensagemEl.innerText = "Preencha todos os campos";
    return;
  }

  emAndamento = true;
  btnGerar.disabled = true;

  formEl.classList.add("hidden");
  resultadoEl.classList.add("hidden");
  loadingEl.classList.remove("hidden");

  try {
    const res = await fetch(
      "https://depix-backend.vercel.app/api/depix",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountInCents: centavos(valor),
          depixAddress: endereco
        })
      }
    );

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    if (
      !data?.response?.qrCopyPaste ||
      !data?.response?.qrImageUrl ||
      !data?.response?.id
    ) {
      throw new Error("Resposta inválida da API");
    }

    qrCopyPaste = data.response.qrCopyPaste;
    qrImageEl.src = data.response.qrImageUrl;
    qrIdEl.innerText = "Identificador: " + data.response.id;

    qrIdEl.onclick = () => {
      navigator.clipboard.writeText(data.response.id);
      mensagemEl.innerText = "Identificador copiado";
    };

    loadingEl.classList.add("hidden");
    resultadoEl.classList.remove("hidden");

  } catch (err) {
    console.error("Erro ao gerar QR Code:", err);

    mensagemEl.innerText =
      err?.message || "Erro ao gerar QR Code";

    loadingEl.classList.add("hidden");
    formEl.classList.remove("hidden");

  } finally {
    emAndamento = false;
    btnGerar.disabled = false;
  }
};

/* ===== Copiar PIX ===== */
btnCopy.onclick = () => {
  if (!qrCopyPaste) return;
  navigator.clipboard.writeText(qrCopyPaste);
  mensagemEl.innerText =
    "Código copiado, cole no app do seu banco";
};

/* ===== Reset ===== */
btnReset.onclick = () => location.reload();

/* ===== PWA Install ===== */

const btnInstall = document.getElementById("btnInstall");
const modal = document.getElementById("installModal");
const closeModal = document.getElementById("closeModal");

let deferredPrompt = null;

// Detecta Android / Desktop
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  btnInstall.classList.remove("hidden");
});

// Clique no botão instalar
btnInstall?.addEventListener("click", async () => {
  // Android / Desktop
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.classList.add("hidden");
    return;
  }

  // iOS → mostrar modal
  if (isIOS()) {
    modal.classList.remove("hidden");
  }
});

// Fechar modal
closeModal?.addEventListener("click", () => {
  modal.classList.add("hidden");
});

// Detecta se já está instalado
window.addEventListener("appinstalled", () => {
  btnInstall.classList.add("hidden");
});

// iOS detect
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

// Se já estiver rodando como app, esconde botão
if (window.matchMedia("(display-mode: standalone)").matches) {
  btnInstall.classList.add("hidden");
}
