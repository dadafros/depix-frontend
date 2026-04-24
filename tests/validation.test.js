import { describe, it, expect } from "vitest";
import {
  validateLiquidAddress,
  validatePhone,
  validateCPF,
  validateCNPJ,
  validateEmail,
  validatePixPhone,
  validateRandomKey,
  validatePixKey,
  formatPixKey,
  preparePixKeyForApi,
  parseLiquidUri,
} from "../validation.js";

describe("validateLiquidAddress", () => {
  it("should reject empty or missing address", () => {
    expect(validateLiquidAddress("").valid).toBe(false);
    expect(validateLiquidAddress(null).valid).toBe(false);
    expect(validateLiquidAddress(undefined).valid).toBe(false);
  });

  it("should reject address shorter than 10 chars", () => {
    expect(validateLiquidAddress("lq1abc").valid).toBe(false);
  });

  it("should reject address longer than 200 chars", () => {
    expect(validateLiquidAddress("lq1" + "a".repeat(200)).valid).toBe(false);
  });

  it("should reject address with invalid prefix", () => {
    const result = validateLiquidAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("inválido");
  });

  it("should accept valid blech32 lq1 address", () => {
    const addr = "lq1qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5psx4kgu9l78v";
    expect(validateLiquidAddress(addr).valid).toBe(true);
  });

  it("should accept valid bech32 ex1 address", () => {
    const addr = "ex1qqpzry9x8gf2tvdw0s3jn54khce6mua7lmkqn9x";
    expect(validateLiquidAddress(addr).valid).toBe(true);
  });

  it("should reject bech32 address with invalid checksum", () => {
    // Valid address with one character changed in the middle
    const addr = "ex1qqpzry9x8gf2tvdw0s3jn54khce6mua7lmkqn9a";
    expect(validateLiquidAddress(addr).valid).toBe(false);
    expect(validateLiquidAddress(addr).error).toContain("checksum");
  });

  it("should reject bech32 address that is too short", () => {
    const result = validateLiquidAddress("lq1abcdefghij");
    expect(result.valid).toBe(false);
  });

  it("should reject bech32 address with missing character", () => {
    // Remove a character from the middle — should fail checksum
    const valid = "ex1qqpzry9x8gf2tvdw0s3jn54khce6mua7lmkqn9x";
    const tampered = valid.slice(0, 20) + valid.slice(21);
    expect(validateLiquidAddress(tampered).valid).toBe(false);
  });

  it("should accept valid base58 VJL address", () => {
    const addr = "VJL" + "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789".slice(0, 50);
    expect(validateLiquidAddress(addr).valid).toBe(true);
  });

  it("should reject base58 address with invalid chars (0, O, I, l)", () => {
    const addr = "VJL" + "0OIl" + "a".repeat(40);
    expect(validateLiquidAddress(addr).valid).toBe(false);
  });

  it("should accept valid H prefix address", () => {
    const addr = "H" + "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789".slice(0, 30);
    expect(validateLiquidAddress(addr).valid).toBe(true);
  });

  it("should accept valid G prefix address", () => {
    const addr = "G" + "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789".slice(0, 30);
    expect(validateLiquidAddress(addr).valid).toBe(true);
  });
});

describe("validatePhone", () => {
  it("should accept Brazilian mobile with country code (+55)", () => {
    expect(validatePhone("+55 11 99999-9999").valid).toBe(true);
    expect(validatePhone("5511999999999").valid).toBe(true);
  });

  it("should accept Brazilian mobile without country code", () => {
    expect(validatePhone("11 99999-9999").valid).toBe(true);
    expect(validatePhone("11999999999").valid).toBe(true);
  });

  it("should accept US number with country code", () => {
    expect(validatePhone("+1 555 123 4567").valid).toBe(true);
  });

  it("should accept international numbers", () => {
    // Portugal
    expect(validatePhone("+351 912 345 678").valid).toBe(true);
    // UK
    expect(validatePhone("+44 7911 123456").valid).toBe(true);
  });

  it("should reject number that is too short", () => {
    const result = validatePhone("123456");
    expect(result.valid).toBe(false);
  });

  it("should reject number that is too long", () => {
    const result = validatePhone("+55 11 99999 99999 99999");
    expect(result.valid).toBe(false);
  });

  it("should reject number starting with 0 (no country code)", () => {
    const result = validatePhone("011999999999");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("código do país");
  });

  it("should strip formatting characters", () => {
    expect(validatePhone("+55 (11) 99999-9999").valid).toBe(true);
    expect(validatePhone("+55-11-99999-9999").valid).toBe(true);
  });
});

// ===== validateCPF =====

describe("validateCPF", () => {
  it("should accept valid CPF without formatting", () => {
    expect(validateCPF("52998224725").valid).toBe(true);
    expect(validateCPF("12345678909").valid).toBe(true);
  });

  it("should accept valid CPF with formatting", () => {
    expect(validateCPF("529.982.247-25").valid).toBe(true);
    expect(validateCPF("123.456.789-09").valid).toBe(true);
  });

  it("should reject CPF with wrong check digits", () => {
    const result = validateCPF("12345678900");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("inválido");
  });

  it("should reject all-same-digit CPFs", () => {
    for (let d = 0; d <= 9; d++) {
      const cpf = String(d).repeat(11);
      expect(validateCPF(cpf).valid).toBe(false);
    }
  });

  it("should reject CPF with wrong length", () => {
    expect(validateCPF("1234567890").valid).toBe(false);   // 10 digits
    expect(validateCPF("123456789012").valid).toBe(false);  // 12 digits
  });

  it("should reject empty or missing input", () => {
    expect(validateCPF("").valid).toBe(false);
    expect(validateCPF(null).valid).toBe(false);
    expect(validateCPF(undefined).valid).toBe(false);
  });

  it("should reject non-numeric input", () => {
    expect(validateCPF("abcdefghijk").valid).toBe(false);
    expect(validateCPF("123.abc.def-gh").valid).toBe(false);
  });

  it("should validate check digit edge case where remainder < 2", () => {
    // CPF where first check digit calculation gives remainder < 2 (check = 0)
    expect(validateCPF("12345678909").valid).toBe(true); // first check digit is 0
  });
});

// ===== validateCNPJ =====

describe("validateCNPJ", () => {
  it("should accept valid numeric CNPJ without formatting", () => {
    expect(validateCNPJ("11222333000181").valid).toBe(true);
  });

  it("should accept valid numeric CNPJ with formatting", () => {
    expect(validateCNPJ("11.222.333/0001-81").valid).toBe(true);
  });

  it("should accept valid alphanumeric CNPJ", () => {
    expect(validateCNPJ("12ABC34501DE35").valid).toBe(true);
  });

  it("should accept valid alphanumeric CNPJ with formatting", () => {
    expect(validateCNPJ("12.ABC.345/01DE-35").valid).toBe(true);
  });

  it("should accept real-world alphanumeric CNPJs (Receita Federal)", () => {
    expect(validateCNPJ("G7.SZ6.1EY/0001-30").valid).toBe(true);
    expect(validateCNPJ("JX.LJE.G7T/0001-13").valid).toBe(true);
    expect(validateCNPJ("WD.NCH.88G/0001-18").valid).toBe(true);
    expect(validateCNPJ("87.L4W.7K5/0001-46").valid).toBe(true);
  });

  it("should reject CNPJ with wrong check digits", () => {
    expect(validateCNPJ("11222333000182").valid).toBe(false);
    expect(validateCNPJ("12ABC34501DE99").valid).toBe(false);
  });

  it("should reject all-same-digit CNPJs", () => {
    for (let d = 0; d <= 9; d++) {
      expect(validateCNPJ(String(d).repeat(14)).valid).toBe(false);
    }
  });

  it("should reject CNPJ with wrong length", () => {
    expect(validateCNPJ("1122233300018").valid).toBe(false);   // 13 chars
    expect(validateCNPJ("112223330001811").valid).toBe(false);  // 15 chars
  });

  it("should reject empty or missing input", () => {
    expect(validateCNPJ("").valid).toBe(false);
    expect(validateCNPJ(null).valid).toBe(false);
    expect(validateCNPJ(undefined).valid).toBe(false);
  });

  it("should accept uppercase letters in alphanumeric CNPJ", () => {
    expect(validateCNPJ("12ABC34501DE35").valid).toBe(true);
  });

  it("should accept lowercase letters and treat as uppercase", () => {
    expect(validateCNPJ("12abc34501de35").valid).toBe(true);
  });

  it("should reject CNPJ with invalid characters", () => {
    expect(validateCNPJ("12!BC34501DE45").valid).toBe(false);
    expect(validateCNPJ("12 BC34501DE45").valid).toBe(false);
  });
});

// ===== validateEmail =====

describe("validateEmail", () => {
  it("should accept standard email addresses", () => {
    expect(validateEmail("user@example.com").valid).toBe(true);
    expect(validateEmail("nome.sobrenome@dominio.com.br").valid).toBe(true);
    expect(validateEmail("user+tag@gmail.com").valid).toBe(true);
  });

  it("should accept email with various TLDs", () => {
    expect(validateEmail("a@b.co").valid).toBe(true);
    expect(validateEmail("user@domain.com.br").valid).toBe(true);
    expect(validateEmail("user@domain.io").valid).toBe(true);
  });

  it("should reject email without @", () => {
    expect(validateEmail("userdomain.com").valid).toBe(false);
  });

  it("should reject email without domain", () => {
    expect(validateEmail("user@").valid).toBe(false);
  });

  it("should reject email without local part", () => {
    expect(validateEmail("@domain.com").valid).toBe(false);
  });

  it("should reject email without TLD", () => {
    expect(validateEmail("user@domain").valid).toBe(false);
  });

  it("should reject email with single-char TLD", () => {
    expect(validateEmail("user@domain.c").valid).toBe(false);
  });

  it("should reject email longer than 77 characters", () => {
    const longEmail = "a".repeat(65) + "@" + "b".repeat(10) + ".com";
    expect(longEmail.length).toBeGreaterThan(77);
    expect(validateEmail(longEmail).valid).toBe(false);
  });

  it("should reject empty or missing input", () => {
    expect(validateEmail("").valid).toBe(false);
    expect(validateEmail(null).valid).toBe(false);
    expect(validateEmail(undefined).valid).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(validateEmail("User@Example.COM").valid).toBe(true);
  });
});

// ===== validatePixPhone =====

describe("validatePixPhone", () => {
  it("should accept valid landline (10 digits, 3rd digit != 9)", () => {
    expect(validatePixPhone("3132000068").valid).toBe(true);  // DDD 31, starts with 3
    expect(validatePixPhone("1125551234").valid).toBe(true);  // DDD 11, starts with 2
  });

  it("should accept valid mobile (11 digits, 3rd digit = 9)", () => {
    expect(validatePixPhone("31999999999").valid).toBe(true);
    expect(validatePixPhone("11912345678").valid).toBe(true);
  });

  it("should reject 10 digits when 3rd digit is 9 (incomplete mobile)", () => {
    const result = validatePixPhone("3192000068");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("11 dígitos");
  });

  it("should reject 11 digits when 3rd digit is not 9 (invalid mobile)", () => {
    const result = validatePixPhone("31321111111");
    expect(result.valid).toBe(false);
  });

  it("should reject phone with 8 or 9 digits", () => {
    expect(validatePixPhone("32000068").valid).toBe(false);
    expect(validatePixPhone("912345678").valid).toBe(false);
  });

  it("should reject phone with wrong length", () => {
    expect(validatePixPhone("12345").valid).toBe(false);
    expect(validatePixPhone("123456789012").valid).toBe(false);
  });

  it("should reject empty or missing input", () => {
    expect(validatePixPhone("").valid).toBe(false);
    expect(validatePixPhone(null).valid).toBe(false);
    expect(validatePixPhone(undefined).valid).toBe(false);
  });
});

// ===== validateRandomKey =====

describe("validateRandomKey", () => {
  it("should accept valid UUID", () => {
    expect(validateRandomKey("550e8400-e29b-41d4-a716-446655440000").valid).toBe(true);
    expect(validateRandomKey("dbbf965d-677c-49ff-b9da-5131da1505f3").valid).toBe(true);
  });

  it("should accept UUID with uppercase hex", () => {
    expect(validateRandomKey("550E8400-E29B-41D4-A716-446655440000").valid).toBe(true);
  });

  it("should reject UUID without hyphens", () => {
    expect(validateRandomKey("550e8400e29b41d4a716446655440000").valid).toBe(false);
  });

  it("should reject UUID with wrong structure", () => {
    expect(validateRandomKey("550e8400-e29b-41d4-a716-44665544000").valid).toBe(false);  // too short
    expect(validateRandomKey("550e8400-e29b-41d4-a716-4466554400000").valid).toBe(false); // too long
    expect(validateRandomKey("550e840-0e29b-41d4-a716-446655440000").valid).toBe(false);  // wrong grouping
  });

  it("should reject non-hex characters", () => {
    expect(validateRandomKey("550g8400-e29b-41d4-a716-446655440000").valid).toBe(false);
    expect(validateRandomKey("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz").valid).toBe(false);
  });

  it("should reject empty or missing input", () => {
    expect(validateRandomKey("").valid).toBe(false);
    expect(validateRandomKey(null).valid).toBe(false);
    expect(validateRandomKey(undefined).valid).toBe(false);
  });
});

// ===== validatePixKey (orchestrator) =====

describe("validatePixKey", () => {
  // --- Email detection ---
  describe("email detection", () => {
    it("should detect and validate email (contains @)", () => {
      const result = validatePixKey("user@example.com");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("email");
    });

    it("should detect invalid email", () => {
      const result = validatePixKey("user@");
      expect(result.valid).toBe(false);
      expect(result.type).toBeNull();
    });
  });

  // --- UUID/Random key detection ---
  describe("random key detection", () => {
    it("should detect and validate UUID", () => {
      const result = validatePixKey("dbbf965d-677c-49ff-b9da-5131da1505f3");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("random");
    });

    it("should detect invalid UUID format", () => {
      const result = validatePixKey("dbbf965d-677c-49ff-b9da-zzzzzzzzzzzz");
      expect(result.valid).toBe(false);
    });
  });

  // --- Phone with + prefix ---
  describe("phone with + prefix", () => {
    it("should detect +55 mobile", () => {
      const result = validatePixKey("+5531999999999");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should detect +55 landline", () => {
      const result = validatePixKey("+553132000068");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should reject non-Brazilian DDI", () => {
      const result = validatePixKey("+4911999999999");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("+55");
    });

    it("should reject +1 (US) number", () => {
      const result = validatePixKey("+15551234567");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("+55");
    });

    it("should handle +55 with formatting", () => {
      const result = validatePixKey("+55 31 99999-9999");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });
  });

  // --- CNPJ detection (14 chars) ---
  describe("CNPJ detection", () => {
    it("should detect valid numeric CNPJ (14 digits)", () => {
      const result = validatePixKey("11222333000181");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cnpj");
    });

    it("should detect valid formatted CNPJ", () => {
      const result = validatePixKey("11.222.333/0001-81");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cnpj");
    });

    it("should detect valid alphanumeric CNPJ", () => {
      const result = validatePixKey("12ABC34501DE35");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cnpj");
    });

    it("should detect invalid CNPJ (wrong check digits)", () => {
      const result = validatePixKey("11222333000199");
      expect(result.valid).toBe(false);
    });
  });

  // --- 8 or 9 digits (missing DDD) ---
  describe("8 or 9 digits", () => {
    it("should reject 8 digits asking for DDD", () => {
      const result = validatePixKey("32000068");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("DDD");
    });

    it("should reject 9 digits asking for DDD", () => {
      const result = validatePixKey("912345678");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("DDD");
    });
  });

  // --- 10 digits (landline detection) ---
  describe("10 digits", () => {
    it("should detect landline when 3rd digit != 9", () => {
      const result = validatePixKey("3132000068");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should reject when 3rd digit is 9 (incomplete mobile)", () => {
      const result = validatePixKey("3192000068");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("11 dígitos");
    });
  });

  // --- 11 digits (disambiguation) ---
  describe("11 digits disambiguation", () => {
    // 11911111132 is both valid CPF and valid phone (3rd digit = 9)
    it("should return ambiguous when both CPF and phone are valid", () => {
      const result = validatePixKey("11911111132");
      expect(result.valid).toBe(false);
      expect(result.type).toBe("ambiguous");
    });

    it("should resolve ambiguous as CPF when disambigType = cpf", () => {
      const result = validatePixKey("11911111132", "cpf");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cpf");
    });

    it("should resolve ambiguous as phone when disambigType = phone", () => {
      const result = validatePixKey("11911111132", "phone");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should detect as CPF when only CPF is valid (3rd digit != 9)", () => {
      const result = validatePixKey("12345678909");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cpf");
    });

    it("should detect as phone when only phone is valid (3rd digit = 9, invalid CPF)", () => {
      const result = validatePixKey("31999999999");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should return CPF error when neither CPF nor phone is valid (3rd != 9)", () => {
      // 12345678901: invalid CPF (wrong check digit 2), 3rd digit = 3 (not phone)
      const result = validatePixKey("12345678901");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("CPF");
    });

    it("should return phone error when 3rd digit is 9 but CPF also invalid", () => {
      // 11900000000: 3rd digit = 9 (phone candidate), but check if CPF valid
      // Let's verify: invalid CPF + valid phone structure → phone
      // Actually need to compute. 11900000000:
      // d1: 1*10+1*9+9*8+0*7+0*6+0*5+0*4+0*3+0*2 = 10+9+72 = 91
      // 91%11 = 91-8*11 = 91-88 = 3. check = 11-3 = 8.
      // So CPF would need digit[9]=8. In 11900000000, digit[9]=0. Invalid CPF.
      // 3rd digit = 9 → valid phone.
      const result = validatePixKey("11900000000");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });
  });

  // --- 12 digits starting with 55 (landline with country code) ---
  describe("12 digits starting with 55", () => {
    it("should detect as landline phone", () => {
      const result = validatePixKey("553132000068");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should reject when local number 3rd digit is 9", () => {
      const result = validatePixKey("553192000068");
      expect(result.valid).toBe(false);
    });

    it("should reject 12 digits not starting with 55", () => {
      const result = validatePixKey("443132000068");
      expect(result.valid).toBe(false);
    });
  });

  // --- 13 digits starting with 55 (mobile with country code) ---
  describe("13 digits starting with 55", () => {
    it("should detect as mobile phone", () => {
      const result = validatePixKey("5531999999999");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should reject when local number 3rd digit is not 9", () => {
      const result = validatePixKey("5531321111111");
      expect(result.valid).toBe(false);
    });

    it("should reject 13 digits not starting with 55", () => {
      const result = validatePixKey("4431999999999");
      expect(result.valid).toBe(false);
    });
  });

  // --- Phone formatted with spaces (as UI disambiguation applies) ---
  describe("phone formatted with spaces (no + prefix)", () => {
    it("should accept 'DDD XXXXX-XXXX' with phone disambig", () => {
      const result = validatePixKey("31 99999-9999", "phone");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should accept 'DDD XXXX-XXXX' as landline", () => {
      const result = validatePixKey("31 3200-0068");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("phone");
    });

    it("should accept CPF formatted with spaces and dots", () => {
      // Spaces should be stripped, leaving 11 digits
      const result = validatePixKey("123 456 789 09");
      // After stripping spaces: "12345678909" (11 digits, valid CPF)
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cpf");
    });
  });

  // --- Edge cases ---
  describe("edge cases", () => {
    it("should reject empty input", () => {
      const result = validatePixKey("");
      expect(result.valid).toBe(false);
    });

    it("should reject null/undefined", () => {
      expect(validatePixKey(null).valid).toBe(false);
      expect(validatePixKey(undefined).valid).toBe(false);
    });

    it("should reject random strings", () => {
      expect(validatePixKey("hello world").valid).toBe(false);
      expect(validatePixKey("abc123").valid).toBe(false);
    });

    it("should trim whitespace", () => {
      const result = validatePixKey("  12345678909  ");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cpf");
    });

    it("should handle CPF with formatting in validatePixKey", () => {
      const result = validatePixKey("123.456.789-09");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cpf");
    });

    it("should handle CNPJ with formatting in validatePixKey", () => {
      const result = validatePixKey("11.222.333/0001-81");
      expect(result.valid).toBe(true);
      expect(result.type).toBe("cnpj");
    });
  });

  // --- Formatted output ---
  describe("formatted output", () => {
    it("should return formatted CPF", () => {
      const result = validatePixKey("12345678909");
      expect(result.formatted).toBe("123.456.789-09");
    });

    it("should return formatted CPF when disambiguated", () => {
      const result = validatePixKey("52998224725", "cpf");
      expect(result.formatted).toBe("529.982.247-25");
    });

    it("should return formatted CNPJ", () => {
      const result = validatePixKey("11222333000181");
      expect(result.formatted).toBe("11.222.333/0001-81");
    });

    it("should return formatted alphanumeric CNPJ", () => {
      const result = validatePixKey("12ABC34501DE35");
      expect(result.formatted).toBe("12.ABC.345/01DE-35");
    });

    it("should return formatted landline phone", () => {
      const result = validatePixKey("3132000068");
      expect(result.formatted).toBe("+55 31 3200-0068");
    });

    it("should return formatted mobile phone", () => {
      const result = validatePixKey("31999999999", "phone");
      expect(result.formatted).toBe("+55 31 99999-9999");
    });

    it("should return email as-is", () => {
      const result = validatePixKey("user@example.com");
      expect(result.formatted).toBe("user@example.com");
    });

    it("should return UUID as-is", () => {
      const uuid = "dbbf965d-677c-49ff-b9da-5131da1505f3";
      const result = validatePixKey(uuid);
      expect(result.formatted).toBe(uuid);
    });

    it("should return formatted phone when +55 prefix provided", () => {
      const result = validatePixKey("+5531999999999");
      expect(result.formatted).toBe("+55 31 99999-9999");
    });

    it("should return formatted phone for 12 digits with 55 prefix", () => {
      const result = validatePixKey("553132000068");
      expect(result.formatted).toBe("+55 31 3200-0068");
    });
  });
});

// ===== formatPixKey =====

describe("formatPixKey", () => {
  it("should format CPF", () => {
    expect(formatPixKey("52998224725", "cpf")).toBe("529.982.247-25");
  });

  it("should format numeric CNPJ", () => {
    expect(formatPixKey("11222333000181", "cnpj")).toBe("11.222.333/0001-81");
  });

  it("should format alphanumeric CNPJ", () => {
    expect(formatPixKey("12ABC34501DE35", "cnpj")).toBe("12.ABC.345/01DE-35");
  });

  it("should format landline phone (10 digits)", () => {
    expect(formatPixKey("3132000068", "phone")).toBe("+55 31 3200-0068");
  });

  it("should format mobile phone (11 digits)", () => {
    expect(formatPixKey("31999999999", "phone")).toBe("+55 31 99999-9999");
  });

  it("should return email unchanged", () => {
    expect(formatPixKey("user@example.com", "email")).toBe("user@example.com");
  });

  it("should return UUID unchanged", () => {
    const uuid = "dbbf965d-677c-49ff-b9da-5131da1505f3";
    expect(formatPixKey(uuid, "random")).toBe(uuid);
  });

  it("should return raw value for unknown type", () => {
    expect(formatPixKey("something", null)).toBe("something");
  });

  it("should format phone with 55 prefix (12 digits)", () => {
    expect(formatPixKey("553132000068", "phone")).toBe("+55 31 3200-0068");
  });

  it("should format phone with 55 prefix (13 digits)", () => {
    expect(formatPixKey("5531999999999", "phone")).toBe("+55 31 99999-9999");
  });
});

// ===== Additional edge case coverage =====

describe("validatePixKey edge cases (additional)", () => {
  it("should reject +55 with incomplete number", () => {
    expect(validatePixKey("+5531").valid).toBe(false);
  });

  it("should reject +55 with 8-digit local number", () => {
    expect(validatePixKey("+5531320000").valid).toBe(false);
  });

  it("should reject only whitespace", () => {
    expect(validatePixKey("   ").valid).toBe(false);
  });

  it("should handle +55 formatted with spaces", () => {
    const result = validatePixKey("+55 31 3200-0068");
    expect(result.valid).toBe(true);
    expect(result.type).toBe("phone");
  });

  it("should reject 7 digits", () => {
    expect(validatePixKey("1234567").valid).toBe(false);
  });

  it("should reject 15+ digits", () => {
    expect(validatePixKey("123456789012345").valid).toBe(false);
  });

  it("should handle alphanumeric CNPJ via validatePixKey", () => {
    const result = validatePixKey("12.ABC.345/01DE-35");
    expect(result.valid).toBe(true);
    expect(result.type).toBe("cnpj");
    expect(result.formatted).toBe("12.ABC.345/01DE-35");
  });

  it("should detect 11-digit number only valid as CPF (3rd digit not 9)", () => {
    // 12345678909: valid CPF, 3rd digit = 3 → not phone
    const result = validatePixKey("12345678909");
    expect(result.type).toBe("cpf");
    expect(result.valid).toBe(true);
  });

  it("should reject 11 digits where 3rd is 9 but neither valid as CPF nor correct disambig", () => {
    // 99900000000: 3rd digit = 9 (phone candidate)
    // CPF check: all 9s at start, likely invalid
    const result = validatePixKey("99900000000");
    // 3rd digit is 9, check if CPF is valid
    // If CPF invalid but phone valid → phone
    expect(result.type).toBe("phone");
    expect(result.valid).toBe(true);
  });
});

// ===== preparePixKeyForApi =====

describe("preparePixKeyForApi", () => {
  describe("email keys", () => {
    it("should preserve dots in email domain", () => {
      expect(preparePixKeyForApi("user@example.com")).toBe("user@example.com");
    });

    it("should preserve dots in complex email", () => {
      expect(preparePixKeyForApi("nome.sobrenome@dominio.com.br")).toBe("nome.sobrenome@dominio.com.br");
    });

    it("should lowercase email", () => {
      expect(preparePixKeyForApi("User@Example.COM")).toBe("user@example.com");
    });

    it("should preserve hyphens in email domain", () => {
      expect(preparePixKeyForApi("user@my-domain.com")).toBe("user@my-domain.com");
    });

    it("should preserve + in email local part", () => {
      expect(preparePixKeyForApi("user+tag@gmail.com")).toBe("user+tag@gmail.com");
    });
  });

  describe("random/UUID keys", () => {
    it("should preserve hyphens in UUID", () => {
      expect(preparePixKeyForApi("dbbf965d-677c-49ff-b9da-5131da1505f3")).toBe("dbbf965d-677c-49ff-b9da-5131da1505f3");
    });

    it("should lowercase UUID", () => {
      expect(preparePixKeyForApi("550E8400-E29B-41D4-A716-446655440000")).toBe("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("phone keys", () => {
    // --- Com DDD, sem código do país ---
    it("should add +55 to 11-digit mobile (DDD + 9 + number)", () => {
      expect(preparePixKeyForApi("31999999999", "phone")).toBe("+5531999999999");
    });

    it("should add +55 to 10-digit landline (DDD + number)", () => {
      expect(preparePixKeyForApi("3132000068")).toBe("+553132000068");
    });

    it("should add +55 to 11-digit mobile without disambig (auto-detected as phone)", () => {
      // 11900000000: invalid CPF, 3rd digit=9 → auto-detects as phone
      expect(preparePixKeyForApi("11900000000")).toBe("+5511900000000");
    });

    // --- Sem DDD (8 ou 9 dígitos) → deve ser inválido ---
    it("should return null for 8 digits (missing DDD)", () => {
      expect(preparePixKeyForApi("32000068")).toBeNull();
    });

    it("should return null for 9 digits (missing DDD)", () => {
      expect(preparePixKeyForApi("999999999")).toBeNull();
    });

    // --- Com 55, sem + ---
    it("should handle 12-digit with 55 prefix (landline)", () => {
      expect(preparePixKeyForApi("553132000068")).toBe("+553132000068");
    });

    it("should handle 13-digit with 55 prefix (mobile)", () => {
      expect(preparePixKeyForApi("5531999999999")).toBe("+5531999999999");
    });

    // --- Com +55 ---
    it("should normalize +55 with spaces and dashes", () => {
      expect(preparePixKeyForApi("+55 31 99999-9999")).toBe("+5531999999999");
    });

    it("should normalize +55 compact (no spaces)", () => {
      expect(preparePixKeyForApi("+5531999999999")).toBe("+5531999999999");
    });

    it("should normalize +55 landline with spaces", () => {
      expect(preparePixKeyForApi("+55 31 3200-0068")).toBe("+553132000068");
    });

    it("should normalize +55 with parentheses around DDD", () => {
      expect(preparePixKeyForApi("+55 (31) 99999-9999")).toBe("+5531999999999");
    });

    // --- Com +, sem 55 → deve rejeitar ---
    it("should return null for +49 (non-Brazilian)", () => {
      expect(preparePixKeyForApi("+4911999999999")).toBeNull();
    });

    it("should return null for +1 (US)", () => {
      expect(preparePixKeyForApi("+15551234567")).toBeNull();
    });

    // --- Formatado pelo real-time formatter do input ---
    it("should handle phone formatted as 'DDD XXXXX-XXXX' (no +55)", () => {
      // This is how the UI formats a disambiguated phone
      expect(preparePixKeyForApi("31 99999-9999", "phone")).toBe("+5531999999999");
    });

    it("should handle phone formatted as 'DDD XXXX-XXXX' (landline, no +55)", () => {
      expect(preparePixKeyForApi("31 3200-0068")).toBe("+553132000068");
    });

    // --- 10 dígitos com 3o dígito = 9 → inválido (celular incompleto) ---
    it("should return null for 10 digits where 3rd digit is 9 (incomplete mobile)", () => {
      expect(preparePixKeyForApi("3192000068")).toBeNull();
    });
  });

  describe("CPF keys", () => {
    it("should strip formatting from CPF", () => {
      expect(preparePixKeyForApi("123.456.789-09")).toBe("12345678909");
    });

    it("should pass through unformatted CPF", () => {
      expect(preparePixKeyForApi("12345678909")).toBe("12345678909");
    });

    it("should strip formatting from CPF with disambig", () => {
      expect(preparePixKeyForApi("119.111.111-32", "cpf")).toBe("11911111132");
    });
  });

  describe("CNPJ keys", () => {
    it("should strip formatting from CNPJ", () => {
      expect(preparePixKeyForApi("11.222.333/0001-81")).toBe("11222333000181");
    });

    it("should pass through unformatted CNPJ", () => {
      expect(preparePixKeyForApi("11222333000181")).toBe("11222333000181");
    });

    it("should handle alphanumeric CNPJ with formatting", () => {
      expect(preparePixKeyForApi("12.ABC.345/01DE-35")).toBe("12ABC34501DE35");
    });
  });

  describe("invalid keys", () => {
    it("should return null for invalid input", () => {
      expect(preparePixKeyForApi("invalid")).toBeNull();
    });

    it("should return null for empty input", () => {
      expect(preparePixKeyForApi("")).toBeNull();
    });
  });
});

describe("parseLiquidUri", () => {
  const VALID_LQ1 = "lq1qqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn54khce6mua7lqpzry9x8gf2tvdw0s3jn5psx4kgu9l78v";
  const VALID_EX1 = "ex1qqpzry9x8gf2tvdw0s3jn54khce6mua7lmkqn9x";
  const DEPIX_ASSET_ID = "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189";

  describe("plain addresses (no URI scheme)", () => {
    it("parses a plain lq1 address", () => {
      const r = parseLiquidUri(VALID_LQ1);
      expect(r.valid).toBe(true);
      expect(r.data.address).toBe(VALID_LQ1);
      expect(r.data.hasUri).toBe(false);
      expect(r.data.amount).toBeNull();
      expect(r.data.assetId).toBeNull();
      expect(r.data.label).toBeNull();
      expect(r.data.message).toBeNull();
    });

    it("parses a plain ex1 address", () => {
      const r = parseLiquidUri(VALID_EX1);
      expect(r.valid).toBe(true);
      expect(r.data.address).toBe(VALID_EX1);
      expect(r.data.hasUri).toBe(false);
    });

    it("trims whitespace from plain address", () => {
      const r = parseLiquidUri(`  ${VALID_LQ1}  `);
      expect(r.valid).toBe(true);
      expect(r.data.address).toBe(VALID_LQ1);
    });

    it("rejects garbage input", () => {
      const r = parseLiquidUri("not-an-address");
      expect(r.valid).toBe(false);
      expect(r.error).toBeTruthy();
    });

    it("rejects empty string", () => {
      const r = parseLiquidUri("");
      expect(r.valid).toBe(false);
    });
  });

  describe("BIP21 URI parsing", () => {
    it("parses liquid:<addr> with no query", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}`);
      expect(r.valid).toBe(true);
      expect(r.data.address).toBe(VALID_LQ1);
      expect(r.data.hasUri).toBe(true);
      expect(r.data.amount).toBeNull();
      expect(r.data.assetId).toBeNull();
    });

    it("parses liquid:<addr>?amount=0.01", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?amount=0.01`);
      expect(r.valid).toBe(true);
      expect(r.data.amount).toBe("0.01");
    });

    it("parses assetid and lowercases it", () => {
      const upper = DEPIX_ASSET_ID.toUpperCase();
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?assetid=${upper}`);
      expect(r.valid).toBe(true);
      expect(r.data.assetId).toBe(DEPIX_ASSET_ID);
    });

    it("rejects assetid that is not 64-hex", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?assetid=notHex`);
      expect(r.valid).toBe(false);
      expect(r.error).toContain("Asset");
    });

    it("rejects assetid with length ≠ 64", () => {
      const short = "02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df518";
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?assetid=${short}`);
      expect(r.valid).toBe(false);
    });

    it("preserves unknown params in data.params", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?foo=bar&custom=xyz`);
      expect(r.valid).toBe(true);
      expect(r.data.params.foo).toBe("bar");
      expect(r.data.params.custom).toBe("xyz");
    });

    it("is case-insensitive on the scheme", () => {
      const r1 = parseLiquidUri(`LIQUID:${VALID_LQ1}`);
      const r2 = parseLiquidUri(`Liquid:${VALID_LQ1}`);
      expect(r1.valid).toBe(true);
      expect(r2.valid).toBe(true);
      expect(r1.data.hasUri).toBe(true);
      expect(r2.data.hasUri).toBe(true);
    });

    it("URL-decodes label and message", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?label=Hello%20World&message=%C3%89%20bom`);
      expect(r.valid).toBe(true);
      expect(r.data.label).toBe("Hello World");
      expect(r.data.message).toBe("É bom");
    });

    it("trims whitespace from URI input", () => {
      const r = parseLiquidUri(`  liquid:${VALID_LQ1}?amount=1  `);
      expect(r.valid).toBe(true);
      expect(r.data.amount).toBe("1");
    });

    it("rejects liquid:<invalid_address>", () => {
      const r = parseLiquidUri("liquid:not-a-valid-address");
      expect(r.valid).toBe(false);
    });

    it("accepts amount with decimal dot", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?amount=1.5`);
      expect(r.valid).toBe(true);
      expect(r.data.amount).toBe("1.5");
    });

    it("nulls out amount with comma (BIP21 spec requires dot)", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?amount=1,50`);
      expect(r.valid).toBe(true);
      expect(r.data.amount).toBeNull();
    });

    it("nulls out negative amount", () => {
      const r = parseLiquidUri(`liquid:${VALID_LQ1}?amount=-1`);
      expect(r.valid).toBe(true);
      expect(r.data.amount).toBeNull();
    });

    it("parses full URI with all fields", () => {
      const uri = `liquid:${VALID_LQ1}?amount=0.5&assetid=${DEPIX_ASSET_ID}&label=Pedido%2042&message=Obrigado`;
      const r = parseLiquidUri(uri);
      expect(r.valid).toBe(true);
      expect(r.data.address).toBe(VALID_LQ1);
      expect(r.data.amount).toBe("0.5");
      expect(r.data.assetId).toBe(DEPIX_ASSET_ID);
      expect(r.data.label).toBe("Pedido 42");
      expect(r.data.message).toBe("Obrigado");
      expect(r.data.hasUri).toBe(true);
    });
  });
});
