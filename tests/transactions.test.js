import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Status label and color mapping tests =====
// These test the pure functions that will be used in transaction rendering

const DEPOSIT_STATUS_LABELS = {
  pending: "Pendente", depix_sent: "Concluído", under_review: "Em análise",
  canceled: "Cancelado", error: "Erro", refunded: "Reembolsado",
  expired: "Expirado", pending_pix2fa: "Aguardando 2FA", delayed: "Atrasado"
};

const WITHDRAW_STATUS_LABELS = {
  unsent: "Aguardando", sending: "Enviando", sent: "Enviado",
  error: "Erro", cancelled: "Cancelado", refunded: "Reembolsado"
};

const NON_TERMINAL_STATUSES = new Set([
  "pending", "sending", "unsent", "under_review", "pending_pix2fa", "delayed"
]);

function statusColor(status) {
  if (["depix_sent", "sent"].includes(status)) return "status-green";
  if (["pending", "sending", "pending_pix2fa"].includes(status)) return "status-yellow";
  if (["under_review", "delayed"].includes(status)) return "status-orange";
  if (["canceled", "cancelled", "error"].includes(status)) return "status-red";
  if (status === "refunded") return "status-blue";
  return "status-gray";
}

describe("Transaction status labels", () => {
  describe("Deposit statuses", () => {
    it("should have labels for all deposit statuses", () => {
      const statuses = ["pending", "depix_sent", "under_review", "canceled", "error", "refunded", "expired", "pending_pix2fa", "delayed"];
      for (const s of statuses) {
        expect(DEPOSIT_STATUS_LABELS[s]).toBeDefined();
        expect(typeof DEPOSIT_STATUS_LABELS[s]).toBe("string");
        expect(DEPOSIT_STATUS_LABELS[s].length).toBeGreaterThan(0);
      }
    });

    it("should map depix_sent to Concluído", () => {
      expect(DEPOSIT_STATUS_LABELS.depix_sent).toBe("Concluído");
    });

    it("should map pending to Pendente", () => {
      expect(DEPOSIT_STATUS_LABELS.pending).toBe("Pendente");
    });
  });

  describe("Withdraw statuses", () => {
    it("should have labels for all withdraw statuses", () => {
      const statuses = ["unsent", "sending", "sent", "error", "cancelled", "refunded"];
      for (const s of statuses) {
        expect(WITHDRAW_STATUS_LABELS[s]).toBeDefined();
        expect(typeof WITHDRAW_STATUS_LABELS[s]).toBe("string");
      }
    });

    it("should map sent to Enviado", () => {
      expect(WITHDRAW_STATUS_LABELS.sent).toBe("Enviado");
    });

    it("should map unsent to Aguardando", () => {
      expect(WITHDRAW_STATUS_LABELS.unsent).toBe("Aguardando");
    });
  });
});

describe("Status color mapping", () => {
  it("should return green for success statuses", () => {
    expect(statusColor("depix_sent")).toBe("status-green");
    expect(statusColor("sent")).toBe("status-green");
  });

  it("should return yellow for pending statuses", () => {
    expect(statusColor("pending")).toBe("status-yellow");
    expect(statusColor("sending")).toBe("status-yellow");
    expect(statusColor("pending_pix2fa")).toBe("status-yellow");
  });

  it("should return orange for review/delayed statuses", () => {
    expect(statusColor("under_review")).toBe("status-orange");
    expect(statusColor("delayed")).toBe("status-orange");
  });

  it("should return red for error/canceled statuses", () => {
    expect(statusColor("canceled")).toBe("status-red");
    expect(statusColor("cancelled")).toBe("status-red");
    expect(statusColor("error")).toBe("status-red");
  });

  it("should return blue for refunded", () => {
    expect(statusColor("refunded")).toBe("status-blue");
  });

  it("should return gray for expired and unsent", () => {
    expect(statusColor("expired")).toBe("status-gray");
    expect(statusColor("unsent")).toBe("status-gray");
  });

  it("should return gray for unknown statuses", () => {
    expect(statusColor("unknown")).toBe("status-gray");
    expect(statusColor("")).toBe("status-gray");
  });
});

describe("Non-terminal status detection", () => {
  it("should identify non-terminal statuses correctly", () => {
    expect(NON_TERMINAL_STATUSES.has("pending")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("sending")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("unsent")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("under_review")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("pending_pix2fa")).toBe(true);
    expect(NON_TERMINAL_STATUSES.has("delayed")).toBe(true);
  });

  it("should identify terminal statuses correctly", () => {
    expect(NON_TERMINAL_STATUSES.has("depix_sent")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("sent")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("canceled")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("cancelled")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("error")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("refunded")).toBe(false);
    expect(NON_TERMINAL_STATUSES.has("expired")).toBe(false);
  });

  it("should correctly determine if polling is needed", () => {
    const allTerminal = [
      { status: "depix_sent" },
      { status: "sent" },
      { status: "canceled" }
    ];
    expect(allTerminal.some(tx => NON_TERMINAL_STATUSES.has(tx.status))).toBe(false);

    const hasPending = [
      { status: "depix_sent" },
      { status: "pending" },
      { status: "sent" }
    ];
    expect(hasPending.some(tx => NON_TERMINAL_STATUSES.has(tx.status))).toBe(true);
  });
});

describe("Router query params handling", () => {
  it("should extract view name from hash with query params", () => {
    const hash = "#transactions?type=deposit&id=abc123";
    const [hashBase] = hash.split("?");
    const viewName = hashBase.replace("#", "");
    expect(viewName).toBe("transactions");
  });

  it("should extract query params from hash", () => {
    const hash = "#transactions?type=deposit&id=abc123";
    const params = new URLSearchParams(hash.split("?")[1] || "");
    expect(params.get("type")).toBe("deposit");
    expect(params.get("id")).toBe("abc123");
  });

  it("should handle hash without query params", () => {
    const hash = "#home";
    const [hashBase] = hash.split("?");
    const viewName = hashBase.replace("#", "");
    expect(viewName).toBe("home");

    const params = new URLSearchParams(hash.split("?")[1] || "");
    expect(params.get("type")).toBeNull();
  });

  it("should handle empty hash", () => {
    const hash = "";
    const fallback = hash || "#login";
    const [hashBase] = fallback.split("?");
    const viewName = hashBase.replace("#", "");
    expect(viewName).toBe("login");
  });
});
