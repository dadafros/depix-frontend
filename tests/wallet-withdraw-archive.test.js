// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const VALID_TXID = "a".repeat(64);

// Mock the apiFetch dependency before importing the module under test.
vi.mock("../api.js", () => ({
  apiFetch: vi.fn()
}));

import { archiveWithdrawTxid } from "../wallet/withdraw-archive.js";
import { apiFetch } from "../api.js";

describe("archiveWithdrawTxid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { ok: true } on 204", async () => {
    apiFetch.mockResolvedValueOnce({ status: 204 });
    const r = await archiveWithdrawTxid({ withdrawalId: "abc", liquidTxid: VALID_TXID });
    expect(r).toEqual({ ok: true });
    const [url, opts] = apiFetch.mock.calls[0];
    expect(url).toBe("/api/withdraw/txid");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ withdrawalId: "abc", liquidTxid: VALID_TXID });
  });

  it("lowercases the txid before sending", async () => {
    apiFetch.mockResolvedValueOnce({ status: 204 });
    await archiveWithdrawTxid({ withdrawalId: "abc", liquidTxid: "F".repeat(64) });
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.liquidTxid).toBe("f".repeat(64));
  });

  it("rejects missing withdrawalId without calling the API", async () => {
    const r = await archiveWithdrawTxid({ withdrawalId: "", liquidTxid: VALID_TXID });
    expect(r).toEqual({ ok: false, reason: "missing-withdrawal-id" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects bad txid format without calling the API", async () => {
    const r = await archiveWithdrawTxid({ withdrawalId: "abc", liquidTxid: "nope" });
    expect(r).toEqual({ ok: false, reason: "bad-txid" });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("treats 409 as idempotent success (row already had liquid_txid set)", async () => {
    // A 409 means an earlier POST for the same withdrawal already won the
    // one-shot write. From the client's perspective that is success, not
    // failure — the correlation is archived. Returning { ok: false } would
    // flag this as a false failure if a future telemetry hook reads .reason.
    apiFetch.mockResolvedValueOnce({ status: 409 });
    const r = await archiveWithdrawTxid({ withdrawalId: "abc", liquidTxid: VALID_TXID });
    expect(r).toEqual({ ok: true, alreadyArchived: true });
  });

  it("reports http status on other non-204 responses", async () => {
    apiFetch.mockResolvedValueOnce({ status: 500 });
    const r = await archiveWithdrawTxid({ withdrawalId: "abc", liquidTxid: VALID_TXID });
    expect(r).toEqual({ ok: false, reason: "http-500" });
  });

  it("reports network error without throwing", async () => {
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    const r = await archiveWithdrawTxid({ withdrawalId: "abc", liquidTxid: VALID_TXID });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("network");
    expect(r.error).toBeInstanceOf(Error);
  });

  it("handles being called without arguments", async () => {
    const r = await archiveWithdrawTxid();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing-withdrawal-id");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
