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

let qrCopyPaste = "";
let deferredPrompt = null;

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
  loading.classList.remove("hidden");

  try {
    const res = await fetch("https://depix-backend.vercel.app/api/depix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountInCents: toCents(valorInput.value),
        depixAddress: enderecoInput.value.trim()
      })
    });

    const data = await res.json();

    if (data?.response?.errorMessage) {
      throw new Error(data.response.errorMessage);
    }

    qrCopyPaste = data.response.qrCopyPaste;
    qrImage.onload = () => {
       qrImage.style.display = "block";
    };

    qrImage.src = data.response.qrImageUrl;
    qrId.innerText = "ID: " + data.response.id;

    resultado.classList.remove("hidden");

  } catch (e) {
    mensagem.innerText = e.message || "Erro ao gerar QR Code";
  } finally {
    loading.classList.add("hidden");
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

btnCopy.onclick = () => {
  navigator.clipboard.writeText(qrCopyPaste);
  showToast("Código copiado. Cole no app do seu banco.");
};

btnReset.onclick = () => location.reload();

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
