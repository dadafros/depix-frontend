import { describe, it, expect } from "vitest";
import { toCents, formatBRL, isAllowedImageUrl } from "../utils.js";

describe("toCents", () => {
  it("should parse simple value", () => {
    expect(toCents("R$ 10,00")).toBe(1000);
  });

  it("should parse value with thousands separator", () => {
    expect(toCents("R$ 1.234,56")).toBe(123456);
  });

  it("should parse value without R$ prefix", () => {
    expect(toCents("10,00")).toBe(1000);
  });

  it("should handle zero", () => {
    expect(toCents("R$ 0,00")).toBe(0);
  });

  it("should handle small cents", () => {
    expect(toCents("R$ 0,01")).toBe(1);
  });

  it("should handle minimum value R$ 5,00", () => {
    expect(toCents("R$ 5,00")).toBe(500);
  });

  it("should handle maximum value R$ 3.000,00", () => {
    expect(toCents("R$ 3.000,00")).toBe(300000);
  });
});

describe("formatBRL", () => {
  it("should format 1000 cents as R$ 10,00", () => {
    expect(formatBRL(1000)).toBe("R$ 10,00");
  });

  it("should format 1 cent as R$ 0,01", () => {
    expect(formatBRL(1)).toBe("R$ 0,01");
  });

  it("should format 0 cents as R$ 0,00", () => {
    expect(formatBRL(0)).toBe("R$ 0,00");
  });

  it("should format 500 cents as R$ 5,00", () => {
    expect(formatBRL(500)).toBe("R$ 5,00");
  });

  it("should format 300000 cents as R$ 3000,00", () => {
    expect(formatBRL(300000)).toBe("R$ 3000,00");
  });

  it("should format 99 cents as R$ 0,99", () => {
    expect(formatBRL(99)).toBe("R$ 0,99");
  });
});

describe("isAllowedImageUrl", () => {
  it("should allow data:image/ URIs", () => {
    expect(isAllowedImageUrl("data:image/png;base64,abc")).toBe(true);
  });

  it("should allow https://depix.eulen.app", () => {
    expect(isAllowedImageUrl("https://depix.eulen.app/qr/123")).toBe(true);
  });

  it("should allow https://eulen.app", () => {
    expect(isAllowedImageUrl("https://eulen.app/image.png")).toBe(true);
  });

  it("should allow https://api.qrserver.com", () => {
    expect(isAllowedImageUrl("https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=test")).toBe(true);
  });

  it("should allow subdomains of allowed hosts", () => {
    expect(isAllowedImageUrl("https://sub.eulen.app/img.png")).toBe(true);
  });

  it("should reject http:// (non-HTTPS)", () => {
    expect(isAllowedImageUrl("http://depix.eulen.app/qr/123")).toBe(false);
  });

  it("should reject unknown hosts", () => {
    expect(isAllowedImageUrl("https://evil.com/fake-qr.png")).toBe(false);
  });

  it("should reject non-string input", () => {
    expect(isAllowedImageUrl(null)).toBe(false);
    expect(isAllowedImageUrl(undefined)).toBe(false);
    expect(isAllowedImageUrl(123)).toBe(false);
  });

  it("should reject malformed URLs", () => {
    expect(isAllowedImageUrl("not-a-url")).toBe(false);
  });

  it("should reject javascript: protocol", () => {
    expect(isAllowedImageUrl("javascript:alert(1)")).toBe(false);
  });

  it("should reject data:text/ URIs", () => {
    expect(isAllowedImageUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });
});
