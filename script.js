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

const btnInstall = document.getElementById("btnInstall");
const modal = document.getElementById("installModal");
const closeModal = document.getElementById("closeModal");

let deferredPrompt = null;
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

/* ===== PWA INSTALL ===== */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  btnInstall.classList.remove("hidden");
});

btnInstall.addEventListener("click", async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.classList.add("hidden");
  } else if (isIOS()) {
    modal.classList.remove("hidden");
  }
});

closeModal.addEventListener("click", () => {
  modal.classList.add("hidden");
});

window.addEventListener("appinstalled", () => {
  btnInstall.classList.add("hidden");
});

if (window.matchMedia("(display-mode: standalone)").matches) {
  btnInstall.classList.add("hidden");
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/* ===== GERAR QR ===== */
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

    qrCopyPaste = data.response.qrCopyPaste;
    qrImageEl.src = data.response.qrImageUrl;
    qrIdEl.innerText = "Identificador: " + data.response.id;

    loadingEl.classList.add("hidden");
    resultadoEl.classList.remove("hidden");

  } catch (err) {
    mensagemEl.innerText = err.message || "Erro ao gerar QR Code";
    loadingEl.classList.add("hidden");
    formEl.classList.remove("hidden");
  } finally {
    emAndamento = false;
    btnGerar.disabled = false;
  }
};

btnCopy.onclick = () => {
  if (!qrCopyPaste) return;
  navigator.clipboard.writeText(qrCopyPaste);
  mensagemEl.innerText = "Código copiado";
};

btnReset.onclick = () => location.reload();
