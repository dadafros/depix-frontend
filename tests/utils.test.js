import { describe, it, expect } from "vitest";
import { toCents, formatBRL, formatDePix, isAllowedImageUrl, escapeHtml, slugify } from "../utils.js";

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

  it("should handle maximum value R$ 6.000,00", () => {
    expect(toCents("R$ 6.000,00")).toBe(600000);
  });

  it("should parse DePix format '150,00 DePix'", () => {
    expect(toCents("150,00 DePix")).toBe(15000);
  });

  it("should parse DePix format '5,00 DePix'", () => {
    expect(toCents("5,00 DePix")).toBe(500);
  });

  it("should parse DePix format '0,01 DePix'", () => {
    expect(toCents("0,01 DePix")).toBe(1);
  });

  it("should parse DePix format '6.000,00 DePix'", () => {
    expect(toCents("6.000,00 DePix")).toBe(600000);
  });

  it("should round-trip: toCents(formatBRL(x)) === x", () => {
    for (const x of [0, 1, 99, 500, 1000, 15000, 600000]) {
      expect(toCents(formatBRL(x))).toBe(x);
    }
  });

  it("should round-trip: toCents(formatDePix(x)) for integer cents", () => {
    for (const x of [1, 99, 500, 1000, 15000, 600000]) {
      const depixStr = formatDePix(x);
      // Extract numeric part before " DePix"
      const numStr = depixStr.replace(" DePix", "").replace(",", ".");
      expect(Math.round(parseFloat(numStr) * 100)).toBe(x);
    }
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

  it("should format 600000 cents as R$ 6.000,00", () => {
    expect(formatBRL(600000)).toBe("R$ 6.000,00");
  });

  it("should format 99 cents as R$ 0,99", () => {
    expect(formatBRL(99)).toBe("R$ 0,99");
  });
});

describe("formatDePix", () => {
  it("should format integer cents with 2 decimal places", () => {
    expect(formatDePix(15000)).toBe("150,00 DePix");
  });

  it("should format small value", () => {
    expect(formatDePix(500)).toBe("5,00 DePix");
  });

  it("should format 1 cent", () => {
    expect(formatDePix(1)).toBe("0,01 DePix");
  });

  it("should show full precision for sub-cent values", () => {
    expect(formatDePix(499.931)).toBe("4,99931 DePix");
  });

  it("should show up to 8 decimal places", () => {
    expect(formatDePix(0.01)).toBe("0,0001 DePix");
  });

  it("should not pad unnecessary zeros beyond 2 decimals", () => {
    expect(formatDePix(510)).toBe("5,10 DePix");
  });

  it("should handle zero", () => {
    expect(formatDePix(0)).toBe("0,00 DePix");
  });

  it("should preserve precision for values like 4.99931", () => {
    // 4.99931 DePix = 499.931 cents
    expect(formatDePix(499.931)).toBe("4,99931 DePix");
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

  it("should reject https://api.qrserver.com (no longer used)", () => {
    expect(isAllowedImageUrl("https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=test")).toBe(false);
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

describe("escapeHtml", () => {
  it("should escape angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("should escape ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("should escape double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("should escape single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#x27;s");
  });

  it("should handle plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("should handle empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("should handle non-string input", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(123)).toBe("");
  });

  it("should escape nested injection attempts", () => {
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).toContain("&lt;img");
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).not.toContain("<img");
  });

  it("should handle Liquid addresses safely", () => {
    const addr = "ex1qw508d6qejxtdg4y5r3zarvary0c5xw7kxw5dkm";
    expect(escapeHtml(addr)).toBe(addr); // no special chars
  });

  it("should handle user names with special chars", () => {
    expect(escapeHtml("João <admin>")).toBe("Jo\u00e3o &lt;admin&gt;");
  });
});

describe("slugify", () => {
  it("should lowercase simple text", () => {
    expect(slugify("Camiseta Preta")).toBe("camiseta-preta");
  });

  it("should remove Portuguese accents", () => {
    expect(slugify("Camiseta Edição Única")).toBe("camiseta-edicao-unica");
    expect(slugify("Pão de Açúcar")).toBe("pao-de-acucar");
  });

  it("should collapse multiple spaces and separators into single hyphen", () => {
    expect(slugify("foo   bar___baz")).toBe("foo-bar-baz");
  });

  it("should strip punctuation", () => {
    expect(slugify("Hello, World! 100%")).toBe("hello-world-100");
  });

  it("should trim leading and trailing hyphens", () => {
    expect(slugify("--foo--")).toBe("foo");
    expect(slugify("!!! bar !!!")).toBe("bar");
  });

  it("should return empty string for empty input", () => {
    expect(slugify("")).toBe("");
    expect(slugify(null)).toBe("");
    expect(slugify(undefined)).toBe("");
  });

  it("should return empty string for only special chars", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  it("should cap length at 60 chars", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(60);
  });

  it("should preserve numbers", () => {
    expect(slugify("Produto 123")).toBe("produto-123");
  });

  it("should handle non-string input", () => {
    expect(slugify(123)).toBe("123");
  });

  it("should produce slug matching backend SLUG_RE", () => {
    const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    const samples = ["Camiseta Preta", "Edição Única", "Produto 2026", "Pão de Açúcar"];
    for (const s of samples) {
      const slug = slugify(s);
      expect(slug.length).toBeGreaterThanOrEqual(2);
      expect(SLUG_RE.test(slug)).toBe(true);
    }
  });
});
