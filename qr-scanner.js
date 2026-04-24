// QR code scanner — reusable modal + camera + rAF decode loop.
//
// Public API (see JSDoc on each export below):
//   scanQRCode(opts)            → Promise<{ rawText, source }>
//   isQrScannerSupported()      → boolean
//   QR_SCANNER_ERRORS           → stable error-code constants
//   QrScannerError              → typed Error with .code
//
// Lifecycle: the modal DOM is mounted lazily on first call and reused on
// subsequent calls. A module-level singleton guarantees only one scan runs
// at a time. All exit paths (resolve, reject, close, abort) go through a
// single cleanup that stops media tracks, cancels the rAF loop, clears
// timers, and detaches document/window listeners.

import { decodeQR } from "./jsqr.js";

export const QR_SCANNER_ERRORS = Object.freeze({
  CANCELLED: "cancelled",
  NO_API: "no-api",
  PERMISSION_DENIED: "permission-denied",
  NO_CAMERA: "no-camera",
  CAMERA_IN_USE: "camera-in-use",
  CAMERA_ERROR: "camera-error",
  BUSY: "busy",
  ABORTED: "aborted",
});

export class QrScannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QrScannerError";
    this.code = code;
  }
}

const SAMPLE_MAX_DIMENSION = 320;
const HINT_DELAY_MS = 5000;
const VALIDATION_CLEAR_MS = 2500;

/** @type {ActiveScanner | null} */
let active = null;
/** @type {HTMLElement | null} */
let modalEl = null;
/** @type {HTMLVideoElement | null} */
let videoEl = null;
let offscreenCanvas = null;
let offscreenCtx = null;

/**
 * @returns {boolean} true when getUserMedia is callable in this environment.
 */
export function isQrScannerSupported() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/**
 * @typedef {Object} QrScanResult
 * @property {string} rawText
 * @property {"camera"} source
 */

/**
 * @typedef {Object} QrScannerOptions
 * @property {string} [title]
 * @property {string} [hint]
 * @property {(text: string) => { ok: boolean, error?: string }} [validate]
 * @property {AbortSignal} [signal]
 * @property {boolean} [hapticOnScan] default true
 */

/**
 * @param {QrScannerOptions} [opts]
 * @returns {Promise<QrScanResult>}
 */
export function scanQRCode(opts = {}) {
  return new Promise((resolve, reject) => {
    if (active) {
      reject(new QrScannerError(QR_SCANNER_ERRORS.BUSY, "Um scanner já está ativo."));
      return;
    }
    if (!isQrScannerSupported()) {
      reject(new QrScannerError(QR_SCANNER_ERRORS.NO_API, "Câmera indisponível neste navegador."));
      return;
    }

    ensureModalMounted();
    applyOptionsToModal(opts);

    const session = {
      resolve,
      reject,
      opts,
      stream: null,
      rafId: null,
      hintTimer: null,
      validationTimer: null,
      listeners: [],
      abortListener: null,
      finished: false,
    };
    active = session;

    const abortListener = () => closeWith(QR_SCANNER_ERRORS.ABORTED, "Scanner abortado.");
    if (opts.signal) {
      if (opts.signal.aborted) {
        active = null;
        reject(new QrScannerError(QR_SCANNER_ERRORS.ABORTED, "Scanner abortado."));
        return;
      }
      opts.signal.addEventListener("abort", abortListener, { once: true });
      session.abortListener = abortListener;
    }

    attachCloseListeners(session);
    showState("prompting");
    modalEl.classList.remove("hidden");

    void startStream(session);
  });
}

/**
 * Test-only helper. Tears down module state between test cases so DOM and
 * singletons don't bleed across suites. Not exported for production use.
 */
export function __resetForTests() {
  if (active) {
    try {
      closeWith(QR_SCANNER_ERRORS.CANCELLED, "reset");
    } catch {
      /* ignore */
    }
  }
  active = null;
  if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
  modalEl = null;
  videoEl = null;
  offscreenCanvas = null;
  offscreenCtx = null;
}

function ensureModalMounted() {
  if (modalEl && document.body.contains(modalEl)) return;
  modalEl = document.createElement("div");
  modalEl.id = "qr-scanner-modal";
  modalEl.className = "modal hidden";
  modalEl.setAttribute("role", "dialog");
  modalEl.setAttribute("aria-modal", "true");
  modalEl.setAttribute("aria-labelledby", "qr-scanner-title");
  modalEl.innerHTML = `
    <div class="modal-box qr-scanner-box">
      <div class="qr-scanner-header">
        <h2 id="qr-scanner-title">Escanear QR code</h2>
        <button id="qr-scanner-close" type="button" class="qr-scanner-close" aria-label="Fechar">&times;</button>
      </div>
      <div id="qr-scanner-prompting" class="qr-scanner-state hidden">
        <p class="qr-scanner-prompting-text">Permita o acesso à câmera para escanear.</p>
      </div>
      <div id="qr-scanner-streaming" class="qr-scanner-state hidden">
        <div class="qr-scanner-viewport">
          <video id="qr-scanner-video" playsinline muted autoplay></video>
          <div class="qr-scanner-reticle" aria-hidden="true"></div>
        </div>
        <p id="qr-scanner-hint" class="qr-scanner-hint">Aponte a câmera para o QR code.</p>
        <button id="qr-scanner-switch" type="button" class="secondary qr-scanner-switch hidden">Trocar câmera</button>
      </div>
      <div id="qr-scanner-error-state" class="qr-scanner-state hidden">
        <div class="qr-scanner-error-icon" aria-hidden="true">!</div>
        <p id="qr-scanner-error-msg" class="qr-scanner-error-msg"></p>
        <button id="qr-scanner-retry" type="button" class="hidden">Tentar novamente</button>
      </div>
      <p id="qr-scanner-validation-msg" class="qr-scanner-validation-msg hidden"></p>
      <div class="qr-scanner-footer">
        <button id="qr-scanner-cancel" type="button" class="secondary">Cancelar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);
  videoEl = modalEl.querySelector("#qr-scanner-video");

  offscreenCanvas = document.createElement("canvas");
  offscreenCtx = offscreenCanvas.getContext("2d");
}

function applyOptionsToModal(opts) {
  if (opts.title) {
    const h = modalEl.querySelector("#qr-scanner-title");
    if (h) h.textContent = opts.title;
  }
  if (opts.hint) {
    const p = modalEl.querySelector("#qr-scanner-hint");
    if (p) p.textContent = opts.hint;
  } else {
    const p = modalEl.querySelector("#qr-scanner-hint");
    if (p) p.textContent = "Aponte a câmera para o QR code.";
  }
  modalEl.querySelector("#qr-scanner-validation-msg").classList.add("hidden");
  modalEl.querySelector("#qr-scanner-retry").classList.add("hidden");
  modalEl.querySelector("#qr-scanner-switch").classList.add("hidden");
  modalEl.querySelector("#qr-scanner-error-msg").textContent = "";
}

function attachCloseListeners(session) {
  const onClose = () => closeWith(QR_SCANNER_ERRORS.CANCELLED, "Fechado pelo usuário.");
  const closeBtn = modalEl.querySelector("#qr-scanner-close");
  const cancelBtn = modalEl.querySelector("#qr-scanner-cancel");
  closeBtn.addEventListener("click", onClose);
  cancelBtn.addEventListener("click", onClose);
  session.listeners.push(() => closeBtn.removeEventListener("click", onClose));
  session.listeners.push(() => cancelBtn.removeEventListener("click", onClose));

  const onKey = (ev) => {
    if (ev.key === "Escape") onClose();
  };
  document.addEventListener("keydown", onKey);
  session.listeners.push(() => document.removeEventListener("keydown", onKey));

  const onHash = () => onClose();
  window.addEventListener("hashchange", onHash);
  session.listeners.push(() => window.removeEventListener("hashchange", onHash));

  const onVis = () => {
    if (!active || active !== session) return;
    if (document.visibilityState === "hidden") stopLoop(session);
    else if (session.stream) startLoop(session);
  };
  document.addEventListener("visibilitychange", onVis);
  session.listeners.push(() => document.removeEventListener("visibilitychange", onVis));

  const retryBtn = modalEl.querySelector("#qr-scanner-retry");
  const onRetry = () => {
    showState("prompting");
    retryBtn.classList.add("hidden");
    void startStream(session);
  };
  retryBtn.addEventListener("click", onRetry);
  session.listeners.push(() => retryBtn.removeEventListener("click", onRetry));

  const switchBtn = modalEl.querySelector("#qr-scanner-switch");
  const onSwitch = () => {
    if (session.videoInputs && session.videoInputs.length >= 2) {
      session.currentDeviceIdx = (session.currentDeviceIdx + 1) % session.videoInputs.length;
      stopStream(session);
      void startStream(session);
    }
  };
  switchBtn.addEventListener("click", onSwitch);
  session.listeners.push(() => switchBtn.removeEventListener("click", onSwitch));
}

async function startStream(session) {
  try {
    const constraints = buildConstraints(session);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (!active || active !== session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    session.stream = stream;
    videoEl.srcObject = stream;
    try {
      await videoEl.play();
    } catch {
      // Safari/iOS occasionally throws on first play() even from a gesture.
      // Retry once in a microtask before giving up.
      await Promise.resolve();
      try {
        await videoEl.play();
      } catch {
        throw new Error("play-failed");
      }
    }
    showState("streaming");
    await maybePopulateVideoInputs(session);
    startHintTimer(session);
    startLoop(session);
  } catch (err) {
    showStreamError(session, err);
  }
}

function buildConstraints(session) {
  if (session.videoInputs && session.currentDeviceIdx != null) {
    const dev = session.videoInputs[session.currentDeviceIdx];
    if (dev && dev.deviceId) {
      return { video: { deviceId: { exact: dev.deviceId } }, audio: false };
    }
  }
  return { video: { facingMode: { ideal: "environment" } }, audio: false };
}

async function maybePopulateVideoInputs(session) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "videoinput");
    session.videoInputs = inputs;
    if (session.currentDeviceIdx == null) session.currentDeviceIdx = 0;
    const switchBtn = modalEl.querySelector("#qr-scanner-switch");
    if (inputs.length >= 2) switchBtn.classList.remove("hidden");
    else switchBtn.classList.add("hidden");
  } catch {
    /* enumerateDevices is best-effort; a failure just hides the switch UI. */
  }
}

function startHintTimer(session) {
  if (session.hintTimer) clearTimeout(session.hintTimer);
  session.hintTimer = setTimeout(() => {
    const hint = modalEl.querySelector("#qr-scanner-hint");
    if (hint) hint.textContent = "Aproxime o celular do QR code. Tente em local bem iluminado.";
  }, HINT_DELAY_MS);
}

function startLoop(session) {
  stopLoop(session);
  const tick = () => {
    if (!active || active !== session) return;
    if (videoEl.readyState >= 2) {
      const result = tryDecodeFrame();
      if (result && handleDecode(session, result)) return;
    }
    session.rafId = requestAnimationFrame(tick);
  };
  session.rafId = requestAnimationFrame(tick);
}

function stopLoop(session) {
  if (session.rafId != null) {
    cancelAnimationFrame(session.rafId);
    session.rafId = null;
  }
}

function tryDecodeFrame() {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(1, SAMPLE_MAX_DIMENSION / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  if (offscreenCanvas.width !== w) offscreenCanvas.width = w;
  if (offscreenCanvas.height !== h) offscreenCanvas.height = h;
  offscreenCtx.drawImage(videoEl, 0, 0, w, h);
  const imageData = offscreenCtx.getImageData(0, 0, w, h);
  return decodeQR(imageData);
}

function handleDecode(session, result) {
  const text = typeof result === "string" ? result : result && result.data;
  if (typeof text !== "string" || !text) return false;

  if (session.opts.validate) {
    let verdict;
    try {
      verdict = session.opts.validate(text);
    } catch {
      verdict = { ok: false, error: "QR inválido." };
    }
    if (!verdict || !verdict.ok) {
      showValidationError(session, verdict && verdict.error ? verdict.error : "QR inválido.");
      return false;
    }
  }

  if (session.opts.hapticOnScan !== false && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    try {
      navigator.vibrate(50);
    } catch {
      /* some browsers throw when vibrate is called without a gesture; ignore */
    }
  }

  finishWithResult(session, text);
  return true;
}

function showValidationError(session, message) {
  const el = modalEl.querySelector("#qr-scanner-validation-msg");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  if (session.validationTimer) clearTimeout(session.validationTimer);
  session.validationTimer = setTimeout(() => {
    el.classList.add("hidden");
    el.textContent = "";
  }, VALIDATION_CLEAR_MS);
}

function showStreamError(session, err) {
  const code = mapErrorToCode(err);
  if (code === QR_SCANNER_ERRORS.PERMISSION_DENIED) {
    renderError("Permissão de câmera negada. Cole o endereço manualmente ou ative a câmera nas configurações do navegador.", false);
  } else if (code === QR_SCANNER_ERRORS.NO_CAMERA) {
    renderError("Nenhuma câmera encontrada neste dispositivo.", false);
  } else if (code === QR_SCANNER_ERRORS.CAMERA_IN_USE) {
    renderError("Câmera em uso por outro aplicativo. Feche e tente novamente.", true);
  } else {
    renderError("Não foi possível iniciar a câmera.", true);
  }
  closeWith(code, err && err.message ? err.message : "Erro ao iniciar câmera.");
}

function renderError(msg, showRetry) {
  showState("error-state");
  const m = modalEl.querySelector("#qr-scanner-error-msg");
  const r = modalEl.querySelector("#qr-scanner-retry");
  if (m) m.textContent = msg;
  if (r) {
    if (showRetry) r.classList.remove("hidden");
    else r.classList.add("hidden");
  }
}

function mapErrorToCode(err) {
  if (!err) return QR_SCANNER_ERRORS.CAMERA_ERROR;
  const name = err.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return QR_SCANNER_ERRORS.PERMISSION_DENIED;
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return QR_SCANNER_ERRORS.NO_CAMERA;
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
    return QR_SCANNER_ERRORS.CAMERA_IN_USE;
  }
  return QR_SCANNER_ERRORS.CAMERA_ERROR;
}

function showState(which) {
  const ids = ["qr-scanner-prompting", "qr-scanner-streaming", "qr-scanner-error-state"];
  for (const id of ids) {
    const el = modalEl.querySelector("#" + id);
    if (!el) continue;
    if (id === "qr-scanner-" + which || id === which) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }
}

function finishWithResult(session, rawText) {
  if (session.finished) return;
  session.finished = true;
  teardown(session);
  session.resolve({ rawText, source: "camera" });
}

function closeWith(code, message) {
  const session = active;
  if (!session || session.finished) return;
  session.finished = true;
  teardown(session);
  session.reject(new QrScannerError(code, message));
}

function teardown(session) {
  stopLoop(session);
  if (session.hintTimer) clearTimeout(session.hintTimer);
  if (session.validationTimer) clearTimeout(session.validationTimer);
  stopStream(session);
  for (const off of session.listeners) {
    try {
      off();
    } catch {
      /* ignore */
    }
  }
  session.listeners = [];
  if (session.abortListener && session.opts.signal) {
    try {
      session.opts.signal.removeEventListener("abort", session.abortListener);
    } catch {
      /* ignore */
    }
  }
  if (modalEl) modalEl.classList.add("hidden");
  active = null;
}

function stopStream(session) {
  if (session.stream) {
    try {
      session.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    session.stream = null;
  }
  if (videoEl) {
    try {
      videoEl.srcObject = null;
    } catch {
      /* ignore */
    }
  }
}
