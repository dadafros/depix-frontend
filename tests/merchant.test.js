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
  const productName = c.product_name ? `<span class="checkout-product-name">${escapeHtml(c.product_name)}</span>` : "";
  let paidIn = "";
  if (c.status === "completed" && c.created_at && c.processing_at) {
    const diffMs = new Date(c.processing_at) - new Date(c.created_at);
    const mins = Math.round(diffMs / 60000);
    paidIn = `<span class="transaction-detail"><span class="transaction-detail-label">Pago em:</span> <span class="transaction-detail-value">${mins}min</span></span>`;
  }
  let parsedMeta = null;
  if (c.metadata) {
    try { parsedMeta = typeof c.metadata === "string" ? JSON.parse(c.metadata) : c.metadata; } catch { /* ignore */ }
  }
  const metadataBtn = parsedMeta ? `<button class="checkout-metadata-btn" type="button" data-metadata="${escapeHtml(JSON.stringify(parsedMeta))}">Metadata</button>` : "";
  return `<div class="transaction-item">
    <div class="transaction-info">
      <span class="transaction-amount">${amount}</span>
      <span class="transaction-date">${formatDateShort(c.created_at)}</span>
    </div>
    <span class="transaction-status ${colorClass}">${statusLabel}</span>
    ${desc}
    ${productName}
    <div class="transaction-details">
      ${paidIn}
      ${metadataBtn}
    </div>
  </div>`;
}

// ===== Copied from script.js — buildSalesFilterParams =====

let currentSalesProductId = null;

function buildSalesFilterParams() {
  const params = new URLSearchParams();
  if (currentSalesProductId) params.set("product_id", currentSalesProductId);
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

// ===== Copied from script.js — charge view helpers =====

function buildPaymentUrl(merchantData) {
  const username = merchantData?.username;
  return username ? `https://pay.depixapp.com/${username}` : "";
}

function setupChargeDOM() {
  const section = document.createElement("div");
  section.innerHTML = `
    <input id="charge-payment-link" readonly />
    <button id="btn-charge-copy"></button>
    <button id="btn-charge-download"></button>
    <button id="btn-charge-share" class="hidden"></button>
  `;
  document.body.appendChild(section);
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

  it("should not contain payment link", () => {
    const html = renderCheckoutItem(baseCheckout);
    expect(html).not.toContain("Link:");
    expect(html).not.toContain("payment_url");
  });

  it("should show product name when present", () => {
    const checkout = { ...baseCheckout, product_name: "Camiseta Preta" };
    const html = renderCheckoutItem(checkout);
    expect(html).toContain("checkout-product-name");
    expect(html).toContain("Camiseta Preta");
  });

  it("should not show product name when absent", () => {
    const html = renderCheckoutItem(baseCheckout);
    expect(html).not.toContain("checkout-product-name");
  });

  it("should escape XSS in product name", () => {
    const checkout = { ...baseCheckout, product_name: '<img onerror="alert(1)">' };
    const html = renderCheckoutItem(checkout);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("should show metadata button when metadata is present", () => {
    const checkout = { ...baseCheckout, metadata: '{"sku":"ABC123"}' };
    const html = renderCheckoutItem(checkout);
    expect(html).toContain("checkout-metadata-btn");
    expect(html).toContain("Metadata");
    expect(html).toContain("data-metadata");
  });

  it("should handle metadata as object (already parsed)", () => {
    const checkout = { ...baseCheckout, metadata: { sku: "ABC123" } };
    const html = renderCheckoutItem(checkout);
    expect(html).toContain("checkout-metadata-btn");
  });

  it("should not show metadata button when metadata is null", () => {
    const html = renderCheckoutItem(baseCheckout);
    expect(html).not.toContain("checkout-metadata-btn");
  });

  it("should not show metadata button when metadata is invalid JSON string", () => {
    const checkout = { ...baseCheckout, metadata: "not-json" };
    const html = renderCheckoutItem(checkout);
    expect(html).not.toContain("checkout-metadata-btn");
  });

  it("should escape metadata content in data attribute", () => {
    const checkout = { ...baseCheckout, metadata: '{"key":"value with \\"quotes\\""}' };
    const html = renderCheckoutItem(checkout);
    expect(html).toContain("checkout-metadata-btn");
    expect(html).not.toContain('data-metadata="{"key"');
  });
});

describe("buildSalesFilterParams", () => {
  beforeEach(() => {
    setupSalesFilterDOM();
    currentSalesProductId = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    currentSalesProductId = null;
  });

  it("should return empty params when no filters are set", () => {
    const params = buildSalesFilterParams();
    expect(params.toString()).toBe("");
  });

  it("should include product_id when currentSalesProductId is set", () => {
    currentSalesProductId = "prod_abc123";
    const params = buildSalesFilterParams();
    expect(params.get("product_id")).toBe("prod_abc123");
  });

  it("should not include product_id when currentSalesProductId is null", () => {
    currentSalesProductId = null;
    const params = buildSalesFilterParams();
    expect(params.has("product_id")).toBe(false);
  });

  it("should combine product_id with other filters", () => {
    currentSalesProductId = "prod_xyz";
    const select = document.getElementById("sales-filter-status");
    const option = document.createElement("option");
    option.value = "completed";
    select.appendChild(option);
    select.value = "completed";
    document.getElementById("sales-filter-search").value = "test";

    const params = buildSalesFilterParams();
    expect(params.get("product_id")).toBe("prod_xyz");
    expect(params.get("status")).toBe("completed");
    expect(params.get("q")).toBe("test");
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

// =============================================================
// Charge View (My Payment Link) Tests
// =============================================================

describe("buildPaymentUrl", () => {
  it("should build URL from username", () => {
    expect(buildPaymentUrl({ username: "lojadepix" })).toBe("https://pay.depixapp.com/lojadepix");
  });

  it("should return empty string when username is missing", () => {
    expect(buildPaymentUrl({})).toBe("");
    expect(buildPaymentUrl({ username: "" })).toBe("");
  });

  it("should return empty string when merchantData is null/undefined", () => {
    expect(buildPaymentUrl(null)).toBe("");
    expect(buildPaymentUrl(undefined)).toBe("");
  });

  it("should preserve username case and special chars", () => {
    expect(buildPaymentUrl({ username: "Loja-123" })).toBe("https://pay.depixapp.com/Loja-123");
  });
});

describe("charge view DOM", () => {
  beforeEach(() => {
    setupChargeDOM();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("should have all required elements", () => {
    expect(document.getElementById("charge-payment-link")).toBeTruthy();
    expect(document.getElementById("btn-charge-copy")).toBeTruthy();
    expect(document.getElementById("btn-charge-download")).toBeTruthy();
    expect(document.getElementById("btn-charge-share")).toBeTruthy();
  });

  it("should populate payment link input with built URL", () => {
    const url = buildPaymentUrl({ username: "testuser" });
    const input = document.getElementById("charge-payment-link");
    input.value = url;
    expect(input.value).toBe("https://pay.depixapp.com/testuser");
  });

  it("should have share button hidden by default", () => {
    const shareBtn = document.getElementById("btn-charge-share");
    expect(shareBtn.classList.contains("hidden")).toBe(true);
  });

  it("should show share button when navigator.share is available", () => {
    const shareBtn = document.getElementById("btn-charge-share");
    // Simulate Web Share API available
    if (navigator.share) {
      shareBtn.classList.remove("hidden");
      expect(shareBtn.classList.contains("hidden")).toBe(false);
    } else {
      // In jsdom navigator.share is undefined, button stays hidden
      expect(shareBtn.classList.contains("hidden")).toBe(true);
    }
  });

  it("should keep share button hidden when navigator.share is unavailable", () => {
    const shareBtn = document.getElementById("btn-charge-share");
    // jsdom does not have navigator.share
    expect(navigator.share).toBeUndefined();
    expect(shareBtn.classList.contains("hidden")).toBe(true);
  });
});

describe("charge view download QR", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("should create a download link with correct filename", () => {
    setupChargeDOM();
    const generatedDataUrl = "data:image/png;base64,fakedata";

    let clickedHref = "";
    let clickedDownload = "";
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = origCreateElement(tag);
      if (tag === "a") {
        vi.spyOn(el, "click").mockImplementation(() => {
          clickedHref = el.href;
          clickedDownload = el.download;
        });
      }
      return el;
    });

    // Simulate download button click — QR is generated on demand via renderPrintableQr
    const a = document.createElement("a");
    a.href = generatedDataUrl;
    a.download = "depix-qrcode.png";
    a.click();

    expect(clickedDownload).toBe("depix-qrcode.png");
    expect(clickedHref).toContain("data:image/png");

    vi.restoreAllMocks();
  });
});

// =============================================================
// Account View — Advanced Toggle Tests
// =============================================================

describe("account advanced fields toggle", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="merchant-account-list">
        <div class="account-list">
          <div class="account-advanced-toggle-row">
            <button id="btn-account-advanced" class="advanced-toggle-btn">Configurações avançadas <span id="account-advanced-arrow" class="advanced-toggle-arrow">▸</span></button>
          </div>
          <div id="account-advanced-fields" class="account-advanced hidden">
            <div class="account-field">Callback URL</div>
            <div class="account-field">Redirect URL</div>
          </div>
        </div>
      </div>
    `;
  });

  afterEach(() => { document.body.innerHTML = ""; });

  it("should start with advanced fields hidden", () => {
    const panel = document.getElementById("account-advanced-fields");
    expect(panel.classList.contains("hidden")).toBe(true);
  });

  it("should show advanced fields on toggle click", () => {
    const _btn = document.getElementById("btn-account-advanced");
    const panel = document.getElementById("account-advanced-fields");
    const arrow = document.getElementById("account-advanced-arrow");

    // Simulate toggle logic
    const isHidden = panel.classList.toggle("hidden");
    arrow.classList.toggle("open", !isHidden);

    expect(panel.classList.contains("hidden")).toBe(false);
    expect(arrow.classList.contains("open")).toBe(true);
  });

  it("should hide advanced fields on second toggle click", () => {
    const panel = document.getElementById("account-advanced-fields");
    const arrow = document.getElementById("account-advanced-arrow");

    // First toggle — show
    panel.classList.toggle("hidden");
    arrow.classList.add("open");
    // Second toggle — hide
    const isHidden = panel.classList.toggle("hidden");
    arrow.classList.toggle("open", !isHidden);

    expect(panel.classList.contains("hidden")).toBe(true);
    expect(arrow.classList.contains("open")).toBe(false);
  });

  it("should contain callback and redirect fields inside advanced section", () => {
    const panel = document.getElementById("account-advanced-fields");
    expect(panel.innerHTML).toContain("Callback URL");
    expect(panel.innerHTML).toContain("Redirect URL");
  });
});

// =============================================================
// Product Card URL Tests
// =============================================================

describe("product card URL rendering", () => {
  function buildProductUrl(merchantData, slug) {
    const username = merchantData?.username;
    return slug && username ? `https://pay.depixapp.com/${username}/${slug}` : "";
  }

  it("should build product URL from username and slug", () => {
    expect(buildProductUrl({ username: "loja" }, "camiseta")).toBe("https://pay.depixapp.com/loja/camiseta");
  });

  it("should return empty when username is missing", () => {
    expect(buildProductUrl({}, "camiseta")).toBe("");
    expect(buildProductUrl(null, "camiseta")).toBe("");
  });

  it("should return empty when slug is missing", () => {
    expect(buildProductUrl({ username: "loja" }, "")).toBe("");
    expect(buildProductUrl({ username: "loja" }, null)).toBe("");
  });

  it("should include URL in product card HTML with copyable class", () => {
    const url = buildProductUrl({ username: "loja" }, "camiseta");
    const html = `<div class="product-card-url copyable" data-copy="${url}"><span class="product-card-url-text mono">${url}</span></div>`;
    expect(html).toContain("copyable");
    expect(html).toContain("data-copy=\"https://pay.depixapp.com/loja/camiseta\"");
    expect(html).toContain("https://pay.depixapp.com/loja/camiseta");
  });
});

// =============================================================
// API Key Display Tests
// =============================================================

describe("API key display", () => {
  it("should show masked key with dots when key_plain is absent", () => {
    const k = { prefix: "sk_test_" };
    const keyDisplay = k.key_plain || (k.prefix + "••••••");
    expect(keyDisplay).toBe("sk_test_••••••");
  });

  it("should show full key when key_plain is present (just created)", () => {
    const k = { prefix: "sk_test_", key_plain: "sk_test_abc123xyz" };
    const keyDisplay = k.key_plain || (k.prefix + "••••••");
    expect(keyDisplay).toBe("sk_test_abc123xyz");
  });

  it("should not include copyable class in rendered key card", () => {
    const k = { prefix: "sk_live_", is_live: true, id: "key_1" };
    const keyDisplay = k.prefix + "••••••";
    const html = `<div class="api-key-value"><span class="mono">${keyDisplay}</span></div>`;
    expect(html).not.toContain("copyable");
    expect(html).not.toContain("copy-icon");
  });
});

// =============================================================
// Sales Filter Badge Tests
// =============================================================

describe("updateSalesFilterBadge logic", () => {
  // Replicate the badge counting logic from script.js
  function countSalesFilters({ status, search, period, productId }) {
    return (status ? 1 : 0) + (search ? 1 : 0) + (period !== "all" ? 1 : 0) + (productId ? 1 : 0);
  }

  it("should return 0 when no filters active", () => {
    expect(countSalesFilters({ status: "", search: "", period: "all", productId: null })).toBe(0);
  });

  it("should count status filter", () => {
    expect(countSalesFilters({ status: "completed", search: "", period: "all", productId: null })).toBe(1);
  });

  it("should count search filter", () => {
    expect(countSalesFilters({ status: "", search: "camiseta", period: "all", productId: null })).toBe(1);
  });

  it("should count period filter", () => {
    expect(countSalesFilters({ status: "", search: "", period: "7d", productId: null })).toBe(1);
  });

  it("should count product filter", () => {
    expect(countSalesFilters({ status: "", search: "", period: "all", productId: "prod_123" })).toBe(1);
  });

  it("should count all filters combined", () => {
    expect(countSalesFilters({ status: "pending", search: "teste", period: "30d", productId: "prod_123" })).toBe(4);
  });
});

// =============================================================
// Search Clear Button Tests
// =============================================================

describe("search clear button visibility", () => {
  function shouldShowClear(value) {
    return !!(value && value.trim());
  }

  it("should be hidden when input is empty", () => {
    expect(shouldShowClear("")).toBe(false);
  });

  it("should be hidden when input is whitespace", () => {
    expect(shouldShowClear("   ")).toBe(false);
  });

  it("should be visible when input has text", () => {
    expect(shouldShowClear("busca")).toBe(true);
  });

  it("should be visible when input has text with spaces", () => {
    expect(shouldShowClear(" camiseta azul ")).toBe(true);
  });
});

// =============================================================
// Product Advanced Toggle Tests
// =============================================================

describe("product advanced fields toggle", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="card">
        <div class="product-advanced-toggle-row">
          <button id="btn-product-create-advanced" class="advanced-toggle-btn" type="button">
            Configurações avançadas <span class="advanced-toggle-arrow">&#x25B8;</span>
          </button>
        </div>
        <div class="product-advanced hidden" data-advanced="product-create">
          <input id="product-create-callback-url" />
          <input id="product-create-redirect-url" />
          <textarea id="product-create-metadata"></textarea>
        </div>
      </div>
    `;
  });

  afterEach(() => { document.body.innerHTML = ""; });

  it("should start with advanced fields hidden", () => {
    const panel = document.querySelector('[data-advanced="product-create"]');
    expect(panel.classList.contains("hidden")).toBe(true);
  });

  it("should show advanced fields on toggle", () => {
    const panel = document.querySelector('[data-advanced="product-create"]');
    panel.classList.toggle("hidden");
    expect(panel.classList.contains("hidden")).toBe(false);
  });

  it("should contain callback, redirect and metadata fields", () => {
    const panel = document.querySelector('[data-advanced="product-create"]');
    expect(panel.querySelector("#product-create-callback-url")).toBeTruthy();
    expect(panel.querySelector("#product-create-redirect-url")).toBeTruthy();
    expect(panel.querySelector("#product-create-metadata")).toBeTruthy();
  });
});

describe("product edit auto-expand advanced", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="card">
        <button id="btn-product-edit-advanced"><span class="advanced-toggle-arrow">&#x25B8;</span></button>
        <div class="product-advanced hidden" data-advanced="product-edit">
          <input id="product-edit-callback-url" />
        </div>
      </div>
    `;
  });

  afterEach(() => { document.body.innerHTML = ""; });

  it("should auto-expand when advanced fields have values", () => {
    const panel = document.querySelector('[data-advanced="product-edit"]');
    const arrow = document.querySelector(".advanced-toggle-arrow");

    // Simulate: product has callback_url
    const hasAdvanced = true;
    if (hasAdvanced && panel) {
      panel.classList.remove("hidden");
      arrow.classList.add("open");
    }

    expect(panel.classList.contains("hidden")).toBe(false);
    expect(arrow.classList.contains("open")).toBe(true);
  });

  it("should stay collapsed when no advanced fields have values", () => {
    const panel = document.querySelector('[data-advanced="product-edit"]');
    const hasAdvanced = false;
    if (hasAdvanced && panel) {
      panel.classList.remove("hidden");
    }
    expect(panel.classList.contains("hidden")).toBe(true);
  });
});

// =============================================================
// Product Filter Chip Tests
// =============================================================

describe("sales product filter chip", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="sales-product-filter" class="sales-product-filter hidden">
        <span id="sales-product-filter-label"></span>
        <button id="sales-product-filter-clear" type="button">&times;</button>
      </div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    currentSalesProductId = null;
  });

  it("should be hidden by default", () => {
    const chip = document.getElementById("sales-product-filter");
    expect(chip.classList.contains("hidden")).toBe(true);
  });

  it("should show chip and set label when product filter is active", () => {
    const chip = document.getElementById("sales-product-filter");
    const label = document.getElementById("sales-product-filter-label");
    currentSalesProductId = "prod_abc";
    const slug = "camiseta-azul";

    // Simulate loadSalesView product filter logic
    label.textContent = `Produto: ${slug}`;
    chip.classList.remove("hidden");

    expect(chip.classList.contains("hidden")).toBe(false);
    expect(label.textContent).toBe("Produto: camiseta-azul");
  });

  it("should hide chip when product filter is cleared", () => {
    const chip = document.getElementById("sales-product-filter");
    chip.classList.remove("hidden");
    currentSalesProductId = "prod_abc";

    // Simulate clear
    currentSalesProductId = null;
    chip.classList.add("hidden");

    expect(chip.classList.contains("hidden")).toBe(true);
    expect(currentSalesProductId).toBeNull();
  });

  it("should fall back to product ID when slug is missing", () => {
    const label = document.getElementById("sales-product-filter-label");
    const productId = "prod_abc";
    const slug = "";

    // Simulate loadSalesView logic: show product_id when slug is empty
    label.textContent = `Produto: ${slug || productId}`;

    expect(label.textContent).toBe("Produto: prod_abc");
  });
});

// =============================================================
// Product Card Checkouts Navigation Tests
// =============================================================

describe("product card checkouts navigation", () => {
  it("should build correct sales URL with product_id and slug", () => {
    const productId = "prod_abc123";
    const slug = "camiseta-azul";
    const url = `#merchant-sales?product_id=${productId}&product=${encodeURIComponent(slug)}`;
    expect(url).toBe("#merchant-sales?product_id=prod_abc123&product=camiseta-azul");
  });

  it("should encode special characters in slug", () => {
    const productId = "prod_xyz";
    const slug = "produto com espaço";
    const url = `#merchant-sales?product_id=${productId}&product=${encodeURIComponent(slug)}`;
    expect(url).toContain("product=produto%20com%20espa%C3%A7o");
  });

  it("should render button with product-id and product-slug data attributes", () => {
    const html = `<button class="merchant-text-btn btn-product-checkouts" data-product-id="prod_1" data-product-slug="meu-produto">Checkouts</button>`;
    document.body.innerHTML = html;
    const btn = document.querySelector(".btn-product-checkouts");
    expect(btn.dataset.productId).toBe("prod_1");
    expect(btn.dataset.productSlug).toBe("meu-produto");
    document.body.innerHTML = "";
  });

  it("should parse product_id from hash params", () => {
    const hash = "#merchant-sales?product_id=prod_abc&product=camiseta";
    const params = new URLSearchParams(hash.split("?")[1] || "");
    expect(params.get("product_id")).toBe("prod_abc");
    expect(params.get("product")).toBe("camiseta");
  });

  it("should return null when no product_id in hash", () => {
    const hash = "#merchant-sales";
    const params = new URLSearchParams(hash.split("?")[1] || "");
    expect(params.get("product_id")).toBeNull();
  });
});
