// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTelemetryClient, TELEMETRY_EVENTS } from "../wallet/telemetry.js";

describe("createTelemetryClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default to no sendBeacon so tests exercise the fetch fallback deterministically.
    if (navigator.sendBeacon) {
      Object.defineProperty(navigator, "sendBeacon", { value: undefined, configurable: true });
    }
  });

  it("posts to the default endpoint with sanitized payload", () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = createTelemetryClient({ fetchImpl, autoContext: false });
    client.track(TELEMETRY_EVENTS.WALLET_CREATED);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://depix-backend.vercel.app/api/wallet/telemetry");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body);
    expect(body.event).toBe("wallet.created");
    expect(body.context).toEqual({});
  });

  it("drops unknown events without posting", () => {
    const fetchImpl = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createTelemetryClient({ fetchImpl });
    client.track("evil.not-in-allowlist", { platform: "ios" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("filters out context keys not in the allowlist", () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = createTelemetryClient({ fetchImpl, autoContext: false });
    client.track(TELEMETRY_EVENTS.SEND_BROADCAST_FAILED, {
      userId: "leak",
      address: "lq1leak",
      errorCode: "ok"
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.context).toEqual({ errorCode: "ok" });
  });

  it("truncates context values to 64 chars", () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = createTelemetryClient({ fetchImpl, autoContext: false });
    client.track(TELEMETRY_EVENTS.WASM_LOAD_TIMEOUT, {
      errorCode: "x".repeat(200)
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.context.errorCode.length).toBe(64);
  });

  it("never throws when fetch rejects", () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const client = createTelemetryClient({ fetchImpl });
    expect(() => client.track(TELEMETRY_EVENTS.WALLET_WIPED)).not.toThrow();
  });

  it("is a no-op when no fetch implementation is available", () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      const client = createTelemetryClient({ fetchImpl: null });
      expect(() => client.track(TELEMETRY_EVENTS.UNLOCK_PIN_WRONG)).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("prefers sendBeacon when available", () => {
    const beacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const fetchImpl = vi.fn();
    const client = createTelemetryClient({ fetchImpl, autoContext: false });
    client.track(TELEMETRY_EVENTS.BIOMETRIC_ENROLL_SUCCESS);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to fetch when sendBeacon returns false", () => {
    const beacon = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const client = createTelemetryClient({ fetchImpl });
    client.track(TELEMETRY_EVENTS.BIOMETRIC_ENROLL_FAILED);
    expect(beacon).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalled();
  });
});
