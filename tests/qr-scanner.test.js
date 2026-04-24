// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../jsqr.js", () => ({ decodeQR: vi.fn() }));

import { decodeQR } from "../jsqr.js";
import {
  scanQRCode,
  isQrScannerSupported,
  QR_SCANNER_ERRORS,
  QrScannerError,
  __resetForTests,
} from "../qr-scanner.js";

function makeMockTrack() {
  return { stop: vi.fn(), readyState: "live", kind: "video" };
}

function makeMockStream(tracks) {
  const actualTracks = tracks ?? [makeMockTrack()];
  return {
    getTracks: () => actualTracks,
    getVideoTracks: () => actualTracks.filter((t) => t.kind === "video"),
    active: true,
  };
}

function installMediaDevices(opts = {}) {
  const stream = opts.stream ?? makeMockStream();
  const getUserMedia = opts.getUserMedia ?? vi.fn(() => Promise.resolve(stream));
  const enumerateDevices = opts.enumerateDevices ?? vi.fn(() =>
    Promise.resolve([{ kind: "videoinput", deviceId: "cam1", label: "Camera 1" }])
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
  return { stream, getUserMedia, enumerateDevices };
}

function uninstallMediaDevices() {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
}

function installVideoStubs({ width = 320, height = 240, readyState = 4 } = {}) {
  const srcObjectSetter = vi.fn();
  let lastSrcObject = null;
  Object.defineProperty(HTMLVideoElement.prototype, "srcObject", {
    configurable: true,
    get() {
      return lastSrcObject;
    },
    set(v) {
      lastSrcObject = v;
      srcObjectSetter(v);
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", {
    configurable: true,
    get: () => width,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", {
    configurable: true,
    get: () => height,
  });
  Object.defineProperty(HTMLVideoElement.prototype, "readyState", {
    configurable: true,
    get: () => readyState,
  });
  HTMLVideoElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLVideoElement.prototype.pause = vi.fn();
  return { srcObjectSetter };
}

function installCanvasStub() {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: vi.fn(),
    getImageData: (_x, _y, w, h) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
  }));
}

function installRafStub() {
  const pending = new Set();
  let nextId = 1;
  globalThis.requestAnimationFrame = vi.fn((cb) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      cb(performance.now());
    }, 0);
    pending.add(id);
    return timer;
  });
  globalThis.cancelAnimationFrame = vi.fn((id) => {
    clearTimeout(id);
    pending.delete(id);
  });
}

async function flushPromises() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

async function tickRaf(times = 1) {
  for (let i = 0; i < times; i++) {
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
  }
}

describe("isQrScannerSupported", () => {
  afterEach(() => {
    uninstallMediaDevices();
  });

  it("returns false when navigator.mediaDevices is undefined", () => {
    uninstallMediaDevices();
    expect(isQrScannerSupported()).toBe(false);
  });

  it("returns false when getUserMedia is missing", () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: vi.fn() },
    });
    expect(isQrScannerSupported()).toBe(false);
  });

  it("returns true when API is available", () => {
    installMediaDevices();
    expect(isQrScannerSupported()).toBe(true);
  });
});

describe("QrScannerError", () => {
  it("carries a stable code and name", () => {
    const e = new QrScannerError(QR_SCANNER_ERRORS.CANCELLED, "user cancelled");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("QrScannerError");
    expect(e.code).toBe("cancelled");
    expect(e.message).toBe("user cancelled");
  });

  it("exposes all documented error codes", () => {
    expect(QR_SCANNER_ERRORS).toMatchObject({
      CANCELLED: "cancelled",
      NO_API: "no-api",
      PERMISSION_DENIED: "permission-denied",
      NO_CAMERA: "no-camera",
      CAMERA_IN_USE: "camera-in-use",
      CAMERA_ERROR: "camera-error",
      BUSY: "busy",
      ABORTED: "aborted",
    });
  });
});

describe("scanQRCode — permission and setup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installVideoStubs();
    installCanvasStub();
    installRafStub();
    decodeQR.mockReset();
    __resetForTests();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    uninstallMediaDevices();
    vi.useRealTimers();
  });

  it("rejects with NO_API when mediaDevices is unavailable", async () => {
    uninstallMediaDevices();
    await expect(scanQRCode()).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.NO_API,
    });
  });

  it("rejects with PERMISSION_DENIED on NotAllowedError", async () => {
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    installMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(err)) });
    const promise = scanQRCode();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.PERMISSION_DENIED,
    });
  });

  it("rejects with NO_CAMERA on NotFoundError", async () => {
    const err = Object.assign(new Error("no cam"), { name: "NotFoundError" });
    installMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(err)) });
    const promise = scanQRCode();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.NO_CAMERA,
    });
  });

  it("rejects with NO_CAMERA on OverconstrainedError", async () => {
    const err = Object.assign(new Error("ovc"), { name: "OverconstrainedError" });
    installMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(err)) });
    const promise = scanQRCode();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.NO_CAMERA,
    });
  });

  it("rejects with CAMERA_IN_USE on NotReadableError", async () => {
    const err = Object.assign(new Error("busy"), { name: "NotReadableError" });
    installMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(err)) });
    const promise = scanQRCode();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.CAMERA_IN_USE,
    });
  });

  it("rejects with CAMERA_ERROR for unknown DOMException names", async () => {
    const err = Object.assign(new Error("weird"), { name: "MysteryError" });
    installMediaDevices({ getUserMedia: vi.fn(() => Promise.reject(err)) });
    const promise = scanQRCode();
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.CAMERA_ERROR,
    });
  });

  it("creates modal DOM lazily on first call and reuses it afterwards", async () => {
    installMediaDevices();
    expect(document.getElementById("qr-scanner-modal")).toBeNull();
    const p1 = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    const modal = document.getElementById("qr-scanner-modal");
    expect(modal).not.toBeNull();

    document.getElementById("qr-scanner-close").click();
    await expect(p1).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });

    const p2 = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    expect(document.getElementById("qr-scanner-modal")).toBe(modal);
    document.getElementById("qr-scanner-close").click();
    await expect(p2).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("rejects BUSY when called while another scan is active", async () => {
    installMediaDevices();
    const p1 = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    await expect(scanQRCode()).rejects.toMatchObject({
      code: QR_SCANNER_ERRORS.BUSY,
    });
    document.getElementById("qr-scanner-close").click();
    await expect(p1).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });
});

describe("scanQRCode — close / cancel paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installVideoStubs();
    installCanvasStub();
    installRafStub();
    decodeQR.mockReset();
    __resetForTests();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    uninstallMediaDevices();
    vi.useRealTimers();
  });

  it("rejects CANCELLED when the X button is clicked", async () => {
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    document.getElementById("qr-scanner-close").click();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("rejects CANCELLED when the cancel button is clicked", async () => {
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    document.getElementById("qr-scanner-cancel").click();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("rejects CANCELLED when Escape key is pressed", async () => {
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("rejects CANCELLED on hashchange", async () => {
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("rejects ABORTED when AbortSignal fires", async () => {
    installMediaDevices();
    const ctrl = new AbortController();
    const p = scanQRCode({ signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.ABORTED });
  });

  it("stops all stream tracks on close (memory leak prevention)", async () => {
    const track = makeMockTrack();
    const stream = makeMockStream([track]);
    installMediaDevices({ stream });
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    document.getElementById("qr-scanner-close").click();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
    expect(track.stop).toHaveBeenCalled();
  });
});

describe("scanQRCode — decode loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installVideoStubs();
    installCanvasStub();
    installRafStub();
    decodeQR.mockReset();
    __resetForTests();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    uninstallMediaDevices();
    vi.useRealTimers();
  });

  it("invokes decodeQR inside the rAF loop", async () => {
    decodeQR.mockReturnValue(null);
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    await tickRaf(3);
    expect(decodeQR).toHaveBeenCalled();
    document.getElementById("qr-scanner-close").click();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("resolves with rawText when decodeQR returns a result", async () => {
    decodeQR.mockReturnValue({ data: "lq1qq-test-address" });
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    await tickRaf(2);
    await expect(p).resolves.toMatchObject({
      rawText: "lq1qq-test-address",
      source: "camera",
    });
  });

  it("calls navigator.vibrate on decode success when hapticOnScan is default", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: vibrate,
    });
    decodeQR.mockReturnValue({ data: "lq1qq-x" });
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    await tickRaf(2);
    await p;
    expect(vibrate).toHaveBeenCalledWith(50);
  });

  it("does not call vibrate when hapticOnScan is false", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: vibrate,
    });
    decodeQR.mockReturnValue({ data: "lq1qq-x" });
    installMediaDevices();
    const p = scanQRCode({ hapticOnScan: false });
    await vi.advanceTimersByTimeAsync(10);
    await tickRaf(2);
    await p;
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("keeps looping when validate rejects and shows inline message", async () => {
    let calls = 0;
    decodeQR.mockImplementation(() => {
      calls++;
      if (calls === 1) return { data: "bad-qr" };
      if (calls === 5) return { data: "lq1-good" };
      return null;
    });
    installMediaDevices();
    const validate = vi.fn((text) =>
      text === "lq1-good" ? { ok: true } : { ok: false, error: "Não é Liquid" }
    );
    const p = scanQRCode({ validate });
    await vi.advanceTimersByTimeAsync(10);
    await tickRaf(8);
    const result = await p;
    expect(result.rawText).toBe("lq1-good");
    expect(validate).toHaveBeenCalledWith("bad-qr");
    expect(validate).toHaveBeenCalledWith("lq1-good");
  });

  it("resolves on first decode when no validate is provided", async () => {
    decodeQR.mockReturnValue({ data: "any-qr-content" });
    installMediaDevices();
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    await tickRaf(2);
    await expect(p).resolves.toMatchObject({ rawText: "any-qr-content" });
  });
});

describe("scanQRCode — camera switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installVideoStubs();
    installCanvasStub();
    installRafStub();
    decodeQR.mockReset();
    decodeQR.mockReturnValue(null);
    __resetForTests();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    uninstallMediaDevices();
    vi.useRealTimers();
  });

  it("hides the switch button when only 1 videoinput exists", async () => {
    installMediaDevices({
      enumerateDevices: vi.fn(() =>
        Promise.resolve([{ kind: "videoinput", deviceId: "a", label: "A" }])
      ),
    });
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    const btn = document.getElementById("qr-scanner-switch");
    expect(btn.classList.contains("hidden")).toBe(true);
    document.getElementById("qr-scanner-close").click();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });

  it("shows the switch button when ≥2 videoinputs exist", async () => {
    installMediaDevices({
      enumerateDevices: vi.fn(() =>
        Promise.resolve([
          { kind: "videoinput", deviceId: "a", label: "A" },
          { kind: "videoinput", deviceId: "b", label: "B" },
        ])
      ),
    });
    const p = scanQRCode();
    await vi.advanceTimersByTimeAsync(10);
    const btn = document.getElementById("qr-scanner-switch");
    expect(btn.classList.contains("hidden")).toBe(false);
    document.getElementById("qr-scanner-close").click();
    await expect(p).rejects.toMatchObject({ code: QR_SCANNER_ERRORS.CANCELLED });
  });
});
