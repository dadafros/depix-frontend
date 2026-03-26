import { describe, it, expect, beforeEach } from "vitest";
import {
  captureReferralCode,
  buildRegistrationBody,
  clearReferralCode,
  buildAffiliateLink,
  renderReferralsHTML
} from "../affiliates.js";

// Mock sessionStorage
const sessionStore = {};
const sessionStorageMock = {
  getItem: (key) => sessionStore[key] || null,
  setItem: (key, value) => { sessionStore[key] = value; },
  removeItem: (key) => { delete sessionStore[key]; },
  clear: () => { for (const k in sessionStore) delete sessionStore[k]; }
};
Object.defineProperty(global, "sessionStorage", { value: sessionStorageMock });

describe("Affiliate program helpers", () => {
  beforeEach(() => {
    sessionStorageMock.clear();
  });

  describe("captureReferralCode", () => {
    it("should store ref from hash with query param", () => {
      captureReferralCode("#landing?ref=abc123");
      expect(sessionStorage.getItem("depix-ref")).toBe("abc123");
    });

    it("should do nothing when no ref param", () => {
      captureReferralCode("#landing?foo=bar");
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });

    it("should do nothing when hash is empty", () => {
      captureReferralCode("");
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });

    it("should do nothing when hash is null", () => {
      captureReferralCode(null);
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });

    it("should do nothing when hash is undefined", () => {
      captureReferralCode(undefined);
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });

    it("should handle hash with multiple params", () => {
      captureReferralCode("#register?utm=twitter&ref=partner42&lang=pt");
      expect(sessionStorage.getItem("depix-ref")).toBe("partner42");
    });

    it("should overwrite existing ref with new one", () => {
      sessionStorage.setItem("depix-ref", "old-code");
      captureReferralCode("#landing?ref=new-code");
      expect(sessionStorage.getItem("depix-ref")).toBe("new-code");
    });

    it("should not overwrite existing ref when no ref param present", () => {
      sessionStorage.setItem("depix-ref", "existing");
      captureReferralCode("#landing?foo=bar");
      expect(sessionStorage.getItem("depix-ref")).toBe("existing");
    });

    it("should handle hash without query string", () => {
      captureReferralCode("#landing");
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });
  });

  describe("buildRegistrationBody", () => {
    const baseFields = {
      nome: "Maria",
      email: "maria@example.com",
      whatsapp: "11999999999",
      usuario: "maria123",
      senha: "secret"
    };

    it("should include ref when present in sessionStorage", () => {
      sessionStorage.setItem("depix-ref", "partner42");
      const body = buildRegistrationBody(baseFields);
      expect(body.ref).toBe("partner42");
    });

    it("should omit ref when not in sessionStorage", () => {
      const body = buildRegistrationBody(baseFields);
      expect(body).not.toHaveProperty("ref");
    });

    it("should preserve all other fields", () => {
      const body = buildRegistrationBody(baseFields);
      expect(body.nome).toBe("Maria");
      expect(body.email).toBe("maria@example.com");
      expect(body.whatsapp).toBe("11999999999");
      expect(body.usuario).toBe("maria123");
      expect(body.senha).toBe("secret");
    });

    it("should preserve all fields when ref is also present", () => {
      sessionStorage.setItem("depix-ref", "abc");
      const body = buildRegistrationBody(baseFields);
      expect(body.nome).toBe("Maria");
      expect(body.email).toBe("maria@example.com");
      expect(body.ref).toBe("abc");
    });

    it("should handle empty fields object with ref", () => {
      sessionStorage.setItem("depix-ref", "code1");
      const body = buildRegistrationBody({});
      expect(body).toEqual({ ref: "code1" });
    });
  });

  describe("clearReferralCode", () => {
    it("should remove depix-ref from sessionStorage", () => {
      sessionStorage.setItem("depix-ref", "to-remove");
      clearReferralCode();
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });

    it("should not throw if key does not exist", () => {
      expect(() => clearReferralCode()).not.toThrow();
    });

    it("should not affect other sessionStorage keys", () => {
      sessionStorage.setItem("depix-ref", "code");
      sessionStorage.setItem("other-key", "value");
      clearReferralCode();
      expect(sessionStorage.getItem("other-key")).toBe("value");
      expect(sessionStorage.getItem("depix-ref")).toBeNull();
    });
  });

  describe("buildAffiliateLink", () => {
    it("should build correct URL from referral code", () => {
      const link = buildAffiliateLink("abc123");
      expect(link).toBe("https://depixapp.com/#landing?ref=abc123");
    });

    it("should handle alphanumeric codes", () => {
      const link = buildAffiliateLink("user-42-xyz");
      expect(link).toBe("https://depixapp.com/#landing?ref=user-42-xyz");
    });

    it("should handle empty string", () => {
      const link = buildAffiliateLink("");
      expect(link).toBe("https://depixapp.com/#landing?ref=");
    });
  });

  describe("renderReferralsHTML", () => {
    const mockFormatBRL = (cents) => `R$ ${(cents / 100).toFixed(2)}`;
    const mockFormatDate = (iso) => new Date(iso).toLocaleDateString("pt-BR");

    it("should return isEmpty true for empty array", () => {
      const result = renderReferralsHTML([], mockFormatBRL, mockFormatDate);
      expect(result.isEmpty).toBe(true);
      expect(result.html).toBe("");
    });

    it("should return isEmpty true for null", () => {
      const result = renderReferralsHTML(null, mockFormatBRL, mockFormatDate);
      expect(result.isEmpty).toBe(true);
      expect(result.html).toBe("");
    });

    it("should return isEmpty true for undefined", () => {
      const result = renderReferralsHTML(undefined, mockFormatBRL, mockFormatDate);
      expect(result.isEmpty).toBe(true);
      expect(result.html).toBe("");
    });

    it("should return correct HTML for single referral", () => {
      const referrals = [
        { nome: "Joao", monthlyVolumeCents: 50000, registeredAt: "2025-06-15T00:00:00Z" }
      ];
      const result = renderReferralsHTML(referrals, mockFormatBRL, mockFormatDate);
      expect(result.isEmpty).toBe(false);
      expect(result.html).toContain("Joao");
      expect(result.html).toContain("R$ 500.00");
      expect(result.html).toContain("Desde");
      expect(result.html).toContain("referral-item");
    });

    it("should return correct HTML for multiple referrals", () => {
      const referrals = [
        { nome: "Ana", monthlyVolumeCents: 10000, registeredAt: "2025-01-10T00:00:00Z" },
        { nome: "Carlos", monthlyVolumeCents: 25000, registeredAt: "2025-03-20T00:00:00Z" }
      ];
      const result = renderReferralsHTML(referrals, mockFormatBRL, mockFormatDate);
      expect(result.isEmpty).toBe(false);
      expect(result.html).toContain("Ana");
      expect(result.html).toContain("Carlos");
      expect(result.html).toContain("R$ 100.00");
      expect(result.html).toContain("R$ 250.00");
    });

    it("should include name, volume, and date in output", () => {
      const referrals = [
        { nome: "Test User", monthlyVolumeCents: 99999, registeredAt: "2025-12-25T00:00:00Z" }
      ];
      const result = renderReferralsHTML(referrals, mockFormatBRL, mockFormatDate);
      expect(result.html).toContain('class="referral-name"');
      expect(result.html).toContain('class="referral-volume"');
      expect(result.html).toContain('class="referral-date"');
      expect(result.html).toContain("Test User");
      expect(result.html).toContain("R$ 999.99");
    });

    it("should use the provided formatBRL function", () => {
      const customFormat = () => "CUSTOM";
      const referrals = [
        { nome: "X", monthlyVolumeCents: 1, registeredAt: "2025-01-01T00:00:00Z" }
      ];
      const result = renderReferralsHTML(referrals, customFormat, mockFormatDate);
      expect(result.html).toContain("CUSTOM");
    });

    it("should use the provided formatDateShort function", () => {
      const customDate = () => "01/jan";
      const referrals = [
        { nome: "Y", monthlyVolumeCents: 1, registeredAt: "2025-01-01T00:00:00Z" }
      ];
      const result = renderReferralsHTML(referrals, mockFormatBRL, customDate);
      expect(result.html).toContain("Desde 01/jan");
    });
  });
});
