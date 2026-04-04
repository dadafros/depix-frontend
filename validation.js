/**
 * Validation utilities for DePix
 */

// === Bech32/Blech32 checksum verification (Liquid addresses) ===

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32Verify(str) {
  str = str.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 7 > str.length || str.length > 130) return false;
  const hrp = str.slice(0, pos);
  const dataChars = str.slice(pos + 1);
  const data = [];
  for (const c of dataChars) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) return false;
    data.push(idx);
  }
  const c = bech32Polymod([...hrpExpand(hrp), ...data]);
  return c === 1 || c === 0x2bc830a3; // bech32 or bech32m
}

function blech32Polymod(values) {
  const GEN = [
    0x7d52fba40bd886n, 0x5e8dbf1a03950cn,
    0x1c3a3c74072a18n, 0x385d72fa0e5139n, 0x7093e5a608865bn
  ];
  let chk = 1n;
  for (const v of values) {
    const b = chk >> 55n;
    chk = ((chk & 0x7fffffffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) {
      if ((b >> BigInt(i)) & 1n) chk ^= GEN[i];
    }
  }
  return chk;
}

function blech32Verify(str) {
  str = str.toLowerCase();
  const pos = str.lastIndexOf("1");
  if (pos < 1 || pos + 13 > str.length) return false;
  const hrp = str.slice(0, pos);
  const dataChars = str.slice(pos + 1);
  const data = [];
  for (const c of dataChars) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx === -1) return false;
    data.push(idx);
  }
  return blech32Polymod([...hrpExpand(hrp), ...data]) === 1n;
}

/**
 * Validate a Liquid Network address with full checksum verification.
 * @param {string} addr
 * @returns {{ valid: boolean, error: string }}
 */
export function validateLiquidAddress(addr) {
  if (!addr || addr.length < 10) {
    return { valid: false, error: "Endereço deve ter no mínimo 10 caracteres" };
  }
  if (addr.length > 200) {
    return { valid: false, error: "Endereço muito longo (máximo 200 caracteres)" };
  }

  const lower = addr.toLowerCase();

  // Bech32 addresses (ex1 = unconfidential, lq1 = confidential)
  if (lower.startsWith("ex1") || lower.startsWith("lq1")) {
    const verify = lower.startsWith("lq1") ? blech32Verify : bech32Verify;
    if (!verify(addr)) {
      return { valid: false, error: "Endereço Liquid inválido (checksum incorreto)" };
    }
    return { valid: true, error: "" };
  }

  // Base58 addresses (legacy)
  const base58Prefixes = ["VJL", "VTp", "VTq", "H", "G"];
  const isBase58 = base58Prefixes.some((p) => addr.startsWith(p));
  if (isBase58) {
    if (
      !/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/.test(addr)
    ) {
      return { valid: false, error: "Endereço contém caracteres inválidos" };
    }
    return { valid: true, error: "" };
  }

  return {
    valid: false,
    error: "Endereço Liquid inválido. Deve começar com lq1, ex1, VJL ou similar.",
  };
}

/**
 * Validate an international phone number format.
 * Requires country code (e.g. +55 for Brazil).
 * Mobile numbers must have at least 10 digits total (country + local).
 * @param {string} phone
 * @returns {{ valid: boolean, error: string }}
 */
export function validatePhone(phone) {
  const digits = phone.replace(/\D/g, "");

  // Minimum: country code (1-3 digits) + local number (7+ digits) = at least 10 digits
  if (digits.length < 10 || digits.length > 15) {
    return {
      valid: false,
      error:
        "Número inválido. Inclua o código do país (ex: +55 11 99999-9999).",
    };
  }

  // Must start with a country code (1-9, no leading zero)
  if (digits.startsWith("0")) {
    return {
      valid: false,
      error: "Inclua o código do país no início (ex: +55 para Brasil).",
    };
  }

  return { valid: true, error: "" };
}

// === CPF validation ===

/**
 * Validate a Brazilian CPF (Cadastro de Pessoa Física).
 * Accepts formatted (XXX.XXX.XXX-XX) or unformatted (11 digits).
 * @param {string} cpf
 * @returns {{ valid: boolean, error: string }}
 */
export function validateCPF(cpf) {
  if (!cpf) return { valid: false, error: "Informe o CPF." };

  const digits = cpf.replace(/[.\-]/g, "");

  if (!/^\d{11}$/.test(digits)) {
    return { valid: false, error: "CPF deve conter exatamente 11 dígitos." };
  }

  if (/^(\d)\1{10}$/.test(digits)) {
    return { valid: false, error: "CPF inválido." };
  }

  const d = digits.split("").map(Number);

  // First check digit
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * (10 - i);
  let rem = sum % 11;
  const check1 = rem < 2 ? 0 : 11 - rem;
  if (d[9] !== check1) {
    return { valid: false, error: "CPF inválido." };
  }

  // Second check digit
  sum = 0;
  for (let i = 0; i < 10; i++) sum += d[i] * (11 - i);
  rem = sum % 11;
  const check2 = rem < 2 ? 0 : 11 - rem;
  if (d[10] !== check2) {
    return { valid: false, error: "CPF inválido." };
  }

  return { valid: true, error: "" };
}

// === CNPJ validation (numeric and alphanumeric) ===

function cnpjCharValue(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;       // '0'-'9' → 0-9
  if (code >= 65 && code <= 90) return code - 55;        // 'A'-'Z' → 10-35
  return -1;
}

/**
 * Validate a Brazilian CNPJ (Cadastro Nacional da Pessoa Jurídica).
 * Supports both traditional numeric and new alphanumeric format.
 * Accepts formatted (XX.XXX.XXX/XXXX-XX) or unformatted (14 chars).
 * @param {string} cnpj
 * @returns {{ valid: boolean, error: string }}
 */
export function validateCNPJ(cnpj) {
  if (!cnpj) return { valid: false, error: "Informe o CNPJ." };

  const stripped = cnpj.replace(/[.\-/]/g, "").toUpperCase();

  if (!/^[0-9A-Z]{14}$/.test(stripped)) {
    return { valid: false, error: "CNPJ deve conter exatamente 14 caracteres alfanuméricos." };
  }

  // Reject all-same-character
  if (/^(.)\1{13}$/.test(stripped)) {
    return { valid: false, error: "CNPJ inválido." };
  }

  const values = stripped.split("").map(cnpjCharValue);
  if (values.some((v) => v < 0)) {
    return { valid: false, error: "CNPJ contém caracteres inválidos." };
  }

  // First check digit (position 12)
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += values[i] * w1[i];
  let rem = sum % 11;
  const check1 = rem < 2 ? 0 : 11 - rem;
  if (values[12] !== check1) {
    return { valid: false, error: "CNPJ inválido." };
  }

  // Second check digit (position 13)
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  sum = 0;
  for (let i = 0; i < 13; i++) sum += values[i] * w2[i];
  rem = sum % 11;
  const check2 = rem < 2 ? 0 : 11 - rem;
  if (values[13] !== check2) {
    return { valid: false, error: "CNPJ inválido." };
  }

  return { valid: true, error: "" };
}

// === Email validation ===

/**
 * Validate an email address for PIX key usage.
 * @param {string} email
 * @returns {{ valid: boolean, error: string }}
 */
export function validateEmail(email) {
  if (!email) return { valid: false, error: "Informe o e-mail." };

  const trimmed = email.trim().toLowerCase();

  if (trimmed.length > 77) {
    return { valid: false, error: "E-mail muito longo (máximo 77 caracteres)." };
  }

  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(trimmed)) {
    return { valid: false, error: "E-mail inválido." };
  }

  return { valid: true, error: "" };
}

// === PIX Phone validation ===

/**
 * Validate a Brazilian phone number for PIX key usage.
 * Receives local digits (without country code 55).
 * 10 digits = landline (3rd digit != 9).
 * 11 digits = mobile (3rd digit = 9).
 * @param {string} digits - Local digits (DDD + number)
 * @returns {{ valid: boolean, error: string }}
 */
export function validatePixPhone(digits) {
  if (!digits) return { valid: false, error: "Informe o número de telefone." };

  const d = digits.replace(/\D/g, "");

  if (d.length === 8 || d.length === 9) {
    return { valid: false, error: "Inclua o DDD (2 dígitos) antes do número." };
  }

  if (d.length === 10) {
    if (d[2] === "9") {
      return { valid: false, error: "Celular deve ter 11 dígitos (DDD + 9 + número)." };
    }
    return { valid: true, error: "" };
  }

  if (d.length === 11) {
    if (d[2] !== "9") {
      return { valid: false, error: "Número de celular deve começar com 9 após o DDD." };
    }
    return { valid: true, error: "" };
  }

  return { valid: false, error: "Número de telefone inválido." };
}

// === Random key (UUID) validation ===

/**
 * Validate a PIX random key (EVP - UUID format).
 * @param {string} key
 * @returns {{ valid: boolean, error: string }}
 */
export function validateRandomKey(key) {
  if (!key) return { valid: false, error: "Informe a chave aleatória." };

  const trimmed = key.trim().toLowerCase();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
    return { valid: false, error: "Chave aleatória inválida. Deve estar no formato UUID." };
  }

  return { valid: true, error: "" };
}

// === PIX key formatting ===

/**
 * Format a PIX key for display.
 * @param {string} raw - Raw key value (digits only for CPF/CNPJ/phone)
 * @param {string|null} type - Key type: "cpf", "cnpj", "email", "phone", "random"
 * @returns {string} Formatted key
 */
export function formatPixKey(raw, type) {
  if (!raw || !type) return raw || "";

  if (type === "cpf") {
    const d = raw.replace(/\D/g, "");
    if (d.length !== 11) return raw;
    return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  }

  if (type === "cnpj") {
    const s = raw.replace(/[.\-/]/g, "");
    if (s.length !== 14) return raw;
    return `${s.slice(0, 2)}.${s.slice(2, 5)}.${s.slice(5, 8)}/${s.slice(8, 12)}-${s.slice(12)}`;
  }

  if (type === "phone") {
    const d = raw.replace(/\D/g, "");
    // Strip leading 55 if present
    const local = d.startsWith("55") && d.length > 11 ? d.slice(2) : d;
    if (local.length === 10) {
      return `+55 ${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
    }
    if (local.length === 11) {
      return `+55 ${local.slice(0, 2)} ${local.slice(2, 7)}-${local.slice(7)}`;
    }
    return raw;
  }

  // email, random: return as-is
  return raw.trim();
}

// === PIX key orchestrator ===

/**
 * Validate and auto-detect a PIX key type.
 * @param {string} key - The PIX key input
 * @param {string} [disambigType] - "cpf" or "phone" when user chose via pills
 * @returns {{ valid: boolean, error: string, type: string|null, formatted: string }}
 */
export function validatePixKey(key, disambigType) {
  const empty = { valid: false, error: "", type: null, formatted: "" };

  if (!key || !key.trim()) {
    return { ...empty, error: "Informe a chave PIX." };
  }

  const trimmed = key.trim();

  // 1. Phone: starts with +
  if (trimmed.startsWith("+")) {
    const digits = trimmed.replace(/\D/g, "");
    if (!digits.startsWith("55")) {
      return { ...empty, error: "Apenas números brasileiros (+55) são aceitos." };
    }
    const local = digits.slice(2);
    const phoneResult = validatePixPhone(local);
    if (!phoneResult.valid) {
      return { ...empty, error: phoneResult.error };
    }
    return {
      valid: true,
      error: "",
      type: "phone",
      formatted: formatPixKey(local, "phone"),
    };
  }

  // 2. Email: contains @
  if (trimmed.includes("@")) {
    const emailResult = validateEmail(trimmed);
    if (!emailResult.valid) {
      return { ...empty, error: emailResult.error };
    }
    return {
      valid: true,
      error: "",
      type: "email",
      formatted: trimmed.trim().toLowerCase(),
    };
  }

  // 3. UUID: 8-4-4-4-12 hex pattern
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed)) {
    const uuidResult = validateRandomKey(trimmed);
    if (!uuidResult.valid) {
      return { ...empty, error: uuidResult.error };
    }
    return {
      valid: true,
      error: "",
      type: "random",
      formatted: trimmed.toLowerCase(),
    };
  }

  // 4. Strip formatting for numeric/alphanumeric detection
  const stripped = trimmed.replace(/[.\-/]/g, "");
  const hasLetters = /[a-zA-Z]/.test(stripped);
  const isAlphanumeric = /^[0-9a-zA-Z]+$/.test(stripped);

  // 5. Alphanumeric with letters → CNPJ (14 chars)
  if (hasLetters && isAlphanumeric) {
    if (stripped.length === 14) {
      const cnpjResult = validateCNPJ(stripped);
      if (!cnpjResult.valid) {
        return { ...empty, error: cnpjResult.error };
      }
      return {
        valid: true,
        error: "",
        type: "cnpj",
        formatted: formatPixKey(stripped, "cnpj"),
      };
    }
    return { ...empty, error: "Chave PIX inválida. Use CPF, CNPJ, e-mail, telefone ou chave aleatória." };
  }

  // 6. Digits only
  const digits = stripped.replace(/\D/g, "");
  if (digits.length !== stripped.length) {
    return { ...empty, error: "Chave PIX inválida. Use CPF, CNPJ, e-mail, telefone ou chave aleatória." };
  }

  const len = digits.length;

  // 8-9 digits: missing DDD
  if (len === 8 || len === 9) {
    return { ...empty, error: "Inclua o DDD (2 dígitos) antes do número." };
  }

  // 10 digits: landline
  if (len === 10) {
    if (digits[2] === "9") {
      return { ...empty, error: "Celular deve ter 11 dígitos (DDD + 9 + número)." };
    }
    return {
      valid: true,
      error: "",
      type: "phone",
      formatted: formatPixKey(digits, "phone"),
    };
  }

  // 11 digits: disambiguation
  if (len === 11) {
    const cpfValid = validateCPF(digits).valid;
    const phoneValid = digits[2] === "9";

    if (disambigType === "cpf") {
      const cpfResult = validateCPF(digits);
      return cpfResult.valid
        ? { valid: true, error: "", type: "cpf", formatted: formatPixKey(digits, "cpf") }
        : { ...empty, error: cpfResult.error };
    }

    if (disambigType === "phone") {
      if (!phoneValid) {
        return { ...empty, error: "Número de celular deve começar com 9 após o DDD." };
      }
      return {
        valid: true,
        error: "",
        type: "phone",
        formatted: formatPixKey(digits, "phone"),
      };
    }

    // No disambigType provided
    if (cpfValid && phoneValid) {
      return { valid: false, error: "", type: "ambiguous", formatted: "" };
    }
    if (cpfValid) {
      return { valid: true, error: "", type: "cpf", formatted: formatPixKey(digits, "cpf") };
    }
    if (phoneValid) {
      return { valid: true, error: "", type: "phone", formatted: formatPixKey(digits, "phone") };
    }
    // Neither valid
    return { ...empty, error: "CPF inválido." };
  }

  // 12 digits starting with 55: landline with country code
  if (len === 12) {
    if (!digits.startsWith("55")) {
      return { ...empty, error: "Chave PIX inválida. Use CPF, CNPJ, e-mail, telefone ou chave aleatória." };
    }
    const local = digits.slice(2);
    const phoneResult = validatePixPhone(local);
    if (!phoneResult.valid) {
      return { ...empty, error: phoneResult.error };
    }
    return {
      valid: true,
      error: "",
      type: "phone",
      formatted: formatPixKey(local, "phone"),
    };
  }

  // 13 digits starting with 55: mobile with country code
  if (len === 13) {
    if (!digits.startsWith("55")) {
      return { ...empty, error: "Chave PIX inválida. Use CPF, CNPJ, e-mail, telefone ou chave aleatória." };
    }
    const local = digits.slice(2);
    const phoneResult = validatePixPhone(local);
    if (!phoneResult.valid) {
      return { ...empty, error: phoneResult.error };
    }
    return {
      valid: true,
      error: "",
      type: "phone",
      formatted: formatPixKey(local, "phone"),
    };
  }

  // 14 digits: CNPJ
  if (len === 14) {
    const cnpjResult = validateCNPJ(digits);
    if (!cnpjResult.valid) {
      return { ...empty, error: cnpjResult.error };
    }
    return {
      valid: true,
      error: "",
      type: "cnpj",
      formatted: formatPixKey(digits, "cnpj"),
    };
  }

  return { ...empty, error: "Chave PIX inválida. Use CPF, CNPJ, e-mail, telefone ou chave aleatória." };
}
