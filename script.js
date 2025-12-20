const valorInput = document.getElementById("valor");
const enderecoInput = document.getElementById("endereco");

const btnGerar = document.getElementById("btnGerar");
const btnCopy = document.getElementById("btnCopy");
const btnReset = document.getElementById("btnReset");

let qrCopyPaste = "";
let emAndamento = false;

/* Formatação moeda */
valorInput.addEventListener("input", () => {
  let v = valorInput.value.replace(/\D/g, "");
  v = (v / 100).toFixed(2).replace(".", ",");
  v = v.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  valorInput.value = "R$ " + v;
});

function centavos(v) {
  return Math.round(
    parseFloat(v.replace("R$", "").replace(/\./g, "").replace(",", ".")) * 100
  );
}

btnGerar.onclick = async () => {
  if (emAndamento) return;

  const valor = valorInput.value;
  const endereco = enderecoInput.value.trim();

  if (!valor || !endereco) {
    alert("Preencha todos os campos");
    return;
  }

  emAndamento = true;
  btnGerar.disabled = true;

  document.getElementById("form").classList.add("hidden");
  document.getElementById("loading").classList.remove("hidden");

  try {
    const res = await fetch("https://depix.davi-bf.workers.dev", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amountInCents: centavos(valor),
        depixAddress: endereco
      })
    });

    const data = await res.json();

    if (!data.response || !data.response.qrCopyPaste) {
      throw new Error(data.error || "Erro ao gerar QR Code");
    }

    qrCopyPaste = data.response.qrCopyPaste;

    document.getElementById("qrImage").src = data.response.qrImageUrl;
    document.getElementById("qrId").innerText =
      "Identificador: " + data.response.id;

    document.getElementById("qrId").onclick = () =>
      navigator.clipboard.writeText(data.response.id);

    document.getElementById("loading").classList.add("hidden");
    document.getElementById("resultado").classList.remove("hidden");

  } catch (err) {
    alert(err.message);
    resetar();
  } finally {
    emAndamento = false;
    btnGerar.disabled = false;
  }
};

btnCopy.onclick = () => {
  navigator.clipboard.writeText(qrCopyPaste);
  document.getElementById("mensagem").innerText =
    "Código copiado, cole no app do seu banco";
};

btnReset.onclick = resetar;

function resetar() {
  location.reload();
}
