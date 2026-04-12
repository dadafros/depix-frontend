// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ===== Copied from script.js — pure checkout utility functions =====

const CHECKOUT_STATUS_LABELS = {
  pending: "Pendente", processing: "Processando", completed: "Concluído",
  expired: "Expirado", cancelled: "Cancelado"
};

const CHECKOUT_NON_TERMINAL = new Set(["pending", "processing"]);

function checkoutStatusColor(status) {
  if (status === "completed") return "status-green";
  if (["pending", "processing"].includes(status)) return "status-yellow";
  if (status === "expired") return "status-gray";
  if (status === "cancelled") return "status-red";
  return "status-gray";
}

// ===== Copied from utils.js — escapeHtml =====

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ===== Copied from utils.js — formatBRL =====

function formatBRL(cents) {
  const value = (cents / 100).toFixed(2);
  const [intPart, decPart] = value.split(".");
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return "R$ " + formatted + "," + decPart;
}

// ===== Copied from script.js — helper functions =====

function abbreviateHash(str, prefixLen = 8, suffixLen = 6) {
  if (!str || str.length <= prefixLen + suffixLen + 3) return str || "";
  return str.slice(0, prefixLen) + "\u2026" + str.slice(-suffixLen);
}

function parseUTC(isoStr) {
  const s = String(isoStr).trim();
  if (s.includes("Z") || s.includes("+")) return new Date(s);
  return new Date(s.replace(" ", "T") + "Z");
}

function formatDateShort(isoStr) {
  if (!isoStr) return "";
  return parseUTC(isoStr).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Sao_Paulo" });
}

// ===== Copied from script.js — renderCheckoutItem =====

function renderCheckoutItem(c) {
  const statusLabel = CHECKOUT_STATUS_LABELS[c.status] || c.status;
  const colorClass = checkoutStatusColor(c.status);
  const amount = formatBRL(c.amount);
  const desc = c.description ? `<span class="checkout-desc">${escapeHtml(c.description)}</span>` : '<span class="checkout-desc text-muted">(sem descrição)</span>';
  const copyIcon = '<svg class="copy-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  let paidIn = "";
  if (c.status === "completed" && c.created_at && c.processing_at) {
    const diffMs = new Date(c.processing_at) - new Date(c.created_at);
    const mins = Math.round(diffMs / 60000);
    paidIn = `<span class="transaction-detail"><span class="transaction-detail-label">Pago em:</span> <span class="transaction-detail-value">${mins}min</span></span>`;
  }
  return `<div class="transaction-item">
    <div class="transaction-info">
      <span class="transaction-amount">${amount}</span>
      <span class="transaction-date">${formatDateShort(c.created_at)}</span>
    </div>
    <span class="transaction-status ${colorClass}">${statusLabel}</span>
    ${desc}
    <div class="transaction-details">
      <span class="transaction-detail copyable mono" data-copy="${escapeHtml(c.id || "")}"><span class="transaction-detail-label">ID:</span> <span class="transaction-detail-value">${escapeHtml(c.id || "")}</span>${copyIcon}</span>
      <span class="transaction-detail copyable mono" data-copy="${escapeHtml(c.payment_url || "")}"><span class="transaction-detail-label">Link:</span> <span class="transaction-detail-value">${escapeHtml(abbreviateHash(c.payment_url || "", 25, 8))}</span>${copyIcon}</span>
      ${paidIn}
    </div>
  </div>`;
}

// ===== Copied from script.js — buildSalesFilterParams =====

function buildSalesFilterParams() {
  const params = new URLSearchParams();
  const status = document.getElementById("sales-filter-status")?.value;
  if (status) params.set("status", status);
  const search = document.getElementById("sales-filter-search")?.value.trim();
  if (search) params.set("q", search);
  const activeBtn = document.querySelector("[data-sales-period].active");
  const period = activeBtn?.dataset.salesPeriod || "all";
  if (period !== "all" && period !== "custom") {
    const now = new Date();
    const fmt = d => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    params.set("to", fmt(now));
    if (period === "today") params.set("from", fmt(now));
    else if (period === "7d") params.set("from", fmt(new Date(now.getTime() - 7 * 86400000)));
    else if (period === "30d") params.set("from", fmt(new Date(now.getTime() - 30 * 86400000)));
    else if (period === "90d") params.set("from", fmt(new Date(now.getTime() - 90 * 86400000)));
  } else if (period === "custom") {
    const from = document.getElementById("sales-filter-start")?.value;
    const to = document.getElementById("sales-filter-end")?.value;
    if (from) params.set("from", from);
    if (to) params.set("to", to);
  }
  return params;
}

// ===== Copied from script.js — client-side filter logic =====

function filterSalesBySearch(checkouts, search) {
  if (!search) return [...checkouts];
  const term = search.toLowerCase();
  return checkouts.filter(c => {
    const fields = [c.description, c.id, String(c.amount)];
    return fields.some(f => f && f.toLowerCase().includes(term));
  });
}

// ===== DOM setup helper =====

function setupSalesFilterDOM() {
  document.body.innerHTML = `
    <select id="sales-filter-status"><option value="">All</option></select>
    <input id="sales-filter-search" value="" />
    <button data-sales-period="all" class="active"></button>
    <button data-sales-period="today"></button>
    <button data-sales-period="7d"></button>
    <button data-sales-period="30d"></button>
    <button data-sales-period="90d"></button>
    <button data-sales-period="custom"></button>
    <input id="sales-filter-start" type="date" />
    <input id="sales-filter-end" type="date" />
  `;
}

function setActivePeriod(period) {
  document.querySelectorAll("[data-sales-period]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.salesPeriod === period);
  });
}

// =============================================================
// Tests
// =============================================================

describe("checkoutStatusColor", () => {
  it("should return status-green for completed", () => {
    expect(checkoutStatusColor("completed")).toBe("status-green");
  });

  it("should return status-yellow for pending", () => {
    expect(checkoutStatusColor("pending")).toBe("status-yellow");
  });

  it("should return status-yellow for processing", () => {
    expect(checkoutStatusColor("processing")).toBe("status-yellow");
  });

  it("should return status-gray for expired", () => {
    expect(checkoutStatusColor("expired")).toBe("status-gray");
  });

  it("should return status-red for cancelled", () => {
    expect(checkoutStatusColor("cancelled")).toBe("status-red");
  });

  it("should return status-gray for unknown status", () => {
    expect(checkoutStatusColor("unknown")).toBe("status-gray");
    expect(checkoutStatusColor("")).toBe("status-gray");
  });
});

describe("CHECKOUT_STATUS_LABELS", () => {
  it("should have all 5 status keys", () => {
    const keys = Object.keys(CHECKOUT_STATUS_LABELS);
    expect(keys).toHaveLength(5);
    expect(keys).toContain("pending");
    expect(keys).toContain("processing");
    expect(keys).toContain("completed");
    expect(keys).toContain("expired");
    expect(keys).toContain("cancelled");
  });

  it("should have correct Portuguese labels", () => {
    expect(CHECKOUT_STATUS_LABELS.pending).toBe("Pendente");
    expect(CHECKOUT_STATUS_LABELS.processing).toBe("Processando");
    expect(CHECKOUT_STATUS_LABELS.completed).toBe("Concluído");
    expect(CHECKOUT_STATUS_LABELS.expired).toBe("Expirado");
    expect(CHECKOUT_STATUS_LABELS.cancelled).toBe("Cancelado");
  });
});

describe("CHECKOUT_NON_TERMINAL", () => {
  it("should contain pending and processing", () => {
    expect(CHECKOUT_NON_TERMINAL.has("pending")).toBe(true);
    expect(CHECKOUT_NON_TERMINAL.has("processing")).toBe(true);
  });

  it("should not contain terminal statuses", () => {
    expect(CHECKOUT_NON_TERMINAL.has("completed")).toBe(false);
    expect(CHECKOUT_NON_TERMINAL.has("expired")).toBe(false);
    expect(CHECKOUT_NON_TERMINAL.has("cancelled")).toBe(false);
  });
});

describe("renderCheckoutItem", () => {
  const baseCheckout = {
    id: "chk_abc123def456",
    status: "pending",
    amount: 150000, // R$ 1.500,00
    description: "Compra de produto",
    payment_url: "https://depixapp.com/pay/chk_abc123def456ghijkl",
    created_at: "2025-03-15T10:30:00Z"
  };

  it("should contain formatted BRL amount", () => {
    const html = renderCheckoutItem(baseCheckout);
    expect(html).toContain("R$ 1.500,00");
  });

  it("should contain correct status label for pending", () => {
    const html = renderCheckoutItem({ ...baseCheckout, status: "pending" });
    expect(html).toContain("Pendente");
    expect(html).toContain("status-yellow");
  });

  it("should contain correct status label for processing", () => {
    const html = renderCheckoutItem({ ...baseCheckout, status: "processing" });
    expect(html).toContain("Processando");
    expect(html).toContain("status-yellow");
  });

  it("should contain correct status label for completed", () => {
    const html = renderCheckoutItem({ ...baseCheckout, status: "completed" });
    expect(html).toContain("Concluído");
    expect(html).toContain("status-green");
  });

  it("should contain correct status label for expired", () => {
    const html = renderCheckoutItem({ ...baseCheckout, status: "expired" });
    expect(html).toContain("Expirado");
    expect(html).toContain("status-gray");
  });

  it("should contain correct status label for cancelled", () => {
    const html = renderCheckoutItem({ ...baseCheckout, status: "cancelled" });
    expect(html).toContain("Cancelado");
    expect(html).toContain("status-red");
  });

  it("should escape XSS in description", () => {
    const xssCheckout = { ...baseCheckout, description: '<script>alert("xss")</script>' };
    const html = renderCheckoutItem(xssCheckout);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("should show (sem descrição) when description is missing", () => {
    const noDesc = { ...baseCheckout, description: "" };
    const html = renderCheckoutItem(noDesc);
    expect(html).toContain("(sem descrição)");
    expect(html).toContain("text-muted");
  });

  it("should show (sem descrição) when description is null", () => {
    const noDesc = { ...baseCheckout, description: null };
    const html = renderCheckoutItem(noDesc);
    expect(html).toContain("(sem descrição)");
  });

  it("should show paidIn minutes when completed with both timestamps", () => {
    const completedCheckout = {
      ...baseCheckout,
      status: "completed",
      created_at: "2025-03-15T10:00:00Z",
      processing_at: "2025-03-15T10:05:00Z"
    };
    const html = renderCheckoutItem(completedCheckout);
    expect(html).toContain("Pago em:");
    expect(html).toContain("5min");
  });

  it("should not show paidIn when status is not completed", () => {
    const pendingCheckout = {
      ...baseCheckout,
      status: "pending",
      created_at: "2025-03-15T10:00:00Z",
      processing_at: "2025-03-15T10:05:00Z"
    };
    const html = renderCheckoutItem(pendingCheckout);
    expect(html).not.toContain("Pago em:");
  });

  it("should not show paidIn when processing_at is missing", () => {
    const noProcessing = {
      ...baseCheckout,
      status: "completed",
      created_at: "2025-03-15T10:00:00Z",
      processing_at: null
    };
    const html = renderCheckoutItem(noProcessing);
    expect(html).not.toContain("Pago em:");
  });

  it("should contain the checkout ID in output", () => {
    const html = renderCheckoutItem(baseCheckout);
    expect(html).toContain("chk_abc123def456");
  });

  it("should contain payment_url in data-copy attribute", () => {
    const html = renderCheckoutItem(baseCheckout);
    expect(html).toContain(baseCheckout.payment_url);
  });

  it("should abbreviate payment_url in display text", () => {
    const longUrl = "https://depixapp.com/pay/chk_abc123def456ghijklmnopqrstuvwxyz";
    const checkout = { ...baseCheckout, payment_url: longUrl };
    const html = renderCheckoutItem(checkout);
    // The abbreviated form should contain the ellipsis character
    expect(html).toContain("\u2026");
    // Full URL should still be in data-copy
    expect(html).toContain(longUrl);
  });
});

describe("buildSalesFilterParams", () => {
  beforeEach(() => {
    setupSalesFilterDOM();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("should return empty params when no filters are set", () => {
    const params = buildSalesFilterParams();
    expect(params.toString()).toBe("");
  });

  it("should include status param when status filter is set", () => {
    const select = document.getElementById("sales-filter-status");
    const option = document.createElement("option");
    option.value = "completed";
    option.textContent = "Completed";
    select.appendChild(option);
    select.value = "completed";

    const params = buildSalesFilterParams();
    expect(params.get("status")).toBe("completed");
  });

  it("should include q param when search is set", () => {
    document.getElementById("sales-filter-search").value = "test search";
    const params = buildSalesFilterParams();
    expect(params.get("q")).toBe("test search");
  });

  it("should trim search whitespace", () => {
    document.getElementById("sales-filter-search").value = "  hello  ";
    const params = buildSalesFilterParams();
    expect(params.get("q")).toBe("hello");
  });

  it("should not include q param when search is empty/whitespace", () => {
    document.getElementById("sales-filter-search").value = "   ";
    const params = buildSalesFilterParams();
    expect(params.has("q")).toBe(false);
  });

  it("should set from===to for today period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T15:00:00Z")); // noon-ish in Sao Paulo
    setActivePeriod("today");

    const params = buildSalesFilterParams();
    expect(params.get("from")).toBe(params.get("to"));
    expect(params.get("from")).toBe("2025-06-15");
  });

  it("should set from to 7 days before to for 7d period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T15:00:00Z"));
    setActivePeriod("7d");

    const params = buildSalesFilterParams();
    expect(params.get("to")).toBe("2025-06-15");
    expect(params.get("from")).toBe("2025-06-08");
  });

  it("should set from to 30 days before to for 30d period", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-30T15:00:00Z"));
    setActivePeriod("30d");

    const params = buildSalesFilterParams();
    expect(params.get("to")).toBe("2025-06-30");
    expect(params.get("from")).toBe("2025-05-31");
  });

  it("should use custom date inputs for custom period", () => {
    setActivePeriod("custom");
    document.getElementById("sales-filter-start").value = "2025-01-01";
    document.getElementById("sales-filter-end").value = "2025-01-31";

    const params = buildSalesFilterParams();
    expect(params.get("from")).toBe("2025-01-01");
    expect(params.get("to")).toBe("2025-01-31");
  });

  it("should not include from/to for all period", () => {
    setActivePeriod("all");
    const params = buildSalesFilterParams();
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
  });
});

describe("filterSalesBySearch", () => {
  const checkouts = [
    { id: "chk_001", description: "Camiseta azul", amount: 5000 },
    { id: "chk_002", description: "Calça jeans", amount: 15000 },
    { id: "chk_003", description: "Tênis branco", amount: 25000 },
    { id: "chk_special", description: null, amount: 9900 }
  ];

  it("should return all checkouts when search is empty", () => {
    expect(filterSalesBySearch(checkouts, "")).toHaveLength(4);
    expect(filterSalesBySearch(checkouts, null)).toHaveLength(4);
    expect(filterSalesBySearch(checkouts, undefined)).toHaveLength(4);
  });

  it("should return a copy, not a reference", () => {
    const result = filterSalesBySearch(checkouts, "");
    expect(result).not.toBe(checkouts);
    expect(result).toEqual(checkouts);
  });

  it("should match by description (case insensitive)", () => {
    const result = filterSalesBySearch(checkouts, "camiseta");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("chk_001");
  });

  it("should match by description with uppercase search", () => {
    const result = filterSalesBySearch(checkouts, "CALÇA");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("chk_002");
  });

  it("should match by id", () => {
    const result = filterSalesBySearch(checkouts, "chk_special");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("chk_special");
  });

  it("should match by amount as string", () => {
    const result = filterSalesBySearch(checkouts, "9900");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("chk_special");
  });

  it("should return empty array when no match", () => {
    const result = filterSalesBySearch(checkouts, "nonexistent_term");
    expect(result).toHaveLength(0);
  });

  it("should handle null description gracefully", () => {
    // chk_special has null description — search by id should still work
    const result = filterSalesBySearch(checkouts, "chk_special");
    expect(result).toHaveLength(1);
  });
});

describe("abbreviateHash", () => {
  it("should return short string as-is", () => {
    expect(abbreviateHash("abc")).toBe("abc");
  });

  it("should return string at threshold length as-is", () => {
    // default: prefixLen=8, suffixLen=6, threshold = 8+6+3 = 17
    const exactLen = "12345678901234567"; // 17 chars
    expect(abbreviateHash(exactLen)).toBe(exactLen);
  });

  it("should truncate string longer than threshold", () => {
    const long = "123456789012345678"; // 18 chars, > 17 threshold
    const result = abbreviateHash(long);
    // prefix 8 chars + ellipsis + suffix 6 chars
    expect(result).toBe("12345678\u2026345678");
  });

  it("should return empty string for empty input", () => {
    expect(abbreviateHash("")).toBe("");
  });

  it("should return empty string for null", () => {
    expect(abbreviateHash(null)).toBe("");
  });

  it("should return empty string for undefined", () => {
    expect(abbreviateHash(undefined)).toBe("");
  });

  it("should use custom prefix/suffix lengths", () => {
    const str = "abcdefghijklmnopqrstuvwxyz"; // 26 chars
    const result = abbreviateHash(str, 4, 3);
    // threshold: 4+3+3 = 10, 26 > 10, so truncate
    expect(result).toBe("abcd\u2026xyz");
  });

  it("should handle custom lengths where string is below threshold", () => {
    const str = "abcdefghij"; // 10 chars
    // threshold: 4+3+3 = 10, not > 10, return as-is
    expect(abbreviateHash(str, 4, 3)).toBe("abcdefghij");
  });
});
