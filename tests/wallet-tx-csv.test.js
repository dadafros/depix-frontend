// @vitest-environment jsdom
//
// Covers wallet/wallet-tx-csv.js — the pure CSV serialization helpers
// behind the #wallet-transactions "Baixar" button. wallet-ui.js owns the
// click listener + Blob/anchor download dance; everything else (escape,
// row shape, multi-asset split, BOM, CRLF) lives here and is tested
// directly.
//
// Invariants locked by these tests:
//   * Formula-injection neutralisation (=+-@\t\r prefix) matches the
//     backend's api/_lib/routes/reports.js `csvEscape` behaviour — a user
//     opening the wallet CSV and the Extrato CSV in the same spreadsheet
//     sees the same escaping rules.
//   * Multi-asset txs expand to one row per asset so each row has a
//     single scalar quantity spreadsheets can aggregate.
//   * BOM + CRLF so Excel on Windows opens acentos cleanly.

import { describe, it, expect } from "vitest";
import { ASSETS } from "../wallet/asset-registry.js";
import {
  CSV_BOM,
  csvEscape,
  formatCsvDateTime,
  walletTxToCsvRows,
  buildWalletTxCsv,
  formatCsvFilenameDate
} from "../wallet/wallet-tx-csv.js";

const DEPIX_ID = ASSETS.DEPIX.id;
const USDT_ID = ASSETS.USDT.id;
const LBTC_ID = ASSETS.LBTC.id;

function makeTx({ type, ts, txid, balance } = {}) {
  return {
    type: type === undefined ? undefined : () => type,
    timestamp: ts === undefined ? undefined : () => ts,
    txid: txid === undefined ? undefined : () => ({ toString: () => txid }),
    balance: () => balance ?? new Map()
  };
}

function balanceMap(entries) {
  const m = new Map();
  for (const [k, v] of entries) m.set({ toString: () => k }, v);
  return m;
}

// ---- csvEscape -----------------------------------------------------------

describe("csvEscape", () => {
  it("passes through plain values unmodified", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape("DePix")).toBe("DePix");
    expect(csvEscape("123.45")).toBe("123.45");
  });

  it("returns empty string for null / undefined / empty", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape("")).toBe("");
  });

  it("quotes + escapes embedded double-quotes", () => {
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
  });

  it("quotes values containing commas or newlines", () => {
    expect(csvEscape("a, b")).toBe('"a, b"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralises formula injection (=/+/-/@/tab/CR) with a leading quote", () => {
    expect(csvEscape("=SUM(A1:A5)")).toBe(`"'=SUM(A1:A5)"`);
    expect(csvEscape("+1")).toBe(`"'+1"`);
    expect(csvEscape("-1")).toBe(`"'-1"`);
    expect(csvEscape("@admin")).toBe(`"'@admin"`);
    expect(csvEscape("\tcmd")).toBe(`"'\tcmd"`);
    expect(csvEscape("\rcmd")).toBe(`"'\rcmd"`);
  });

  it("coerces non-string values via String()", () => {
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });
});

// ---- formatCsvDateTime ---------------------------------------------------

describe("formatCsvDateTime", () => {
  it("formats epoch ms as dd/mm/yyyy hh:mm in local time", () => {
    const ms = new Date(2026, 3, 24, 9, 5).getTime();
    expect(formatCsvDateTime(ms)).toBe("24/04/2026 09:05");
  });

  it("zero-pads single-digit fields", () => {
    const ms = new Date(2026, 0, 1, 3, 7).getTime();
    expect(formatCsvDateTime(ms)).toBe("01/01/2026 03:07");
  });

  it("returns empty string for null / undefined / NaN", () => {
    expect(formatCsvDateTime(null)).toBe("");
    expect(formatCsvDateTime(undefined)).toBe("");
    expect(formatCsvDateTime(NaN)).toBe("");
  });
});

// ---- walletTxToCsvRows ---------------------------------------------------

describe("walletTxToCsvRows", () => {
  it("emits one row per known asset with the correct sign", () => {
    const tx = makeTx({
      type: "incoming",
      ts: new Date(2026, 3, 24, 9, 5).getTime() / 1000,
      txid: "abcdef",
      balance: balanceMap([[DEPIX_ID, 100_000_000n], [USDT_ID, -50_000_000n]])
    });
    const rows = walletTxToCsvRows(tx);
    expect(rows.length).toBe(2);
    // DePix positive
    expect(rows[0][0]).toBe("24/04/2026 09:05");
    expect(rows[0][1]).toBe("Recebido");
    expect(rows[0][2]).toBe("DePix");
    expect(rows[0][3].startsWith("-")).toBe(false);
    expect(rows[0][4]).toBe("abcdef");
    // USDt negative
    expect(rows[1][2]).toBe("USDt");
    expect(rows[1][3].startsWith("-")).toBe(true);
  });

  it("emits exactly one row for a tx with zero known assets", () => {
    const tx = makeTx({
      ts: new Date(2026, 3, 24, 9, 5).getTime() / 1000,
      txid: "abcdef",
      balance: new Map()
    });
    const rows = walletTxToCsvRows(tx);
    expect(rows.length).toBe(1);
    expect(rows[0][2]).toBe("");
    expect(rows[0][3]).toBe("");
  });

  it("uses 'Enviado' for outgoing and 'Outro' for mixed/empty direction", () => {
    const out = makeTx({ type: "outgoing", balance: balanceMap([[LBTC_ID, -1n]]) });
    expect(walletTxToCsvRows(out)[0][1]).toBe("Enviado");

    const mixed = makeTx({ balance: balanceMap([[DEPIX_ID, 1n], [USDT_ID, -1n]]) });
    // No type() + mixed balance → "Outro" (undetermined direction).
    expect(walletTxToCsvRows(mixed)[0][1]).toBe("Outro");
  });

  it("emits empty date cell when timestamp is missing (row still present)", () => {
    const tx = makeTx({ txid: "xx", balance: balanceMap([[DEPIX_ID, 1n]]) });
    const rows = walletTxToCsvRows(tx);
    expect(rows[0][0]).toBe("");
    expect(rows[0][4]).toBe("xx");
  });

  it("emits empty txid cell when txid() is absent", () => {
    const tx = makeTx({
      ts: 1_700_000_000,
      balance: balanceMap([[DEPIX_ID, 1n]])
    });
    expect(walletTxToCsvRows(tx)[0][4]).toBe("");
  });

  it("orders multi-asset rows deterministically (DePix → USDt → L-BTC)", () => {
    // Insert in REVERSE of display order — if the implementation relied on
    // Object.keys insertion order, rows[0] would be L-BTC. Display order
    // places DePix first regardless of how LWK returned the balance map.
    const tx = makeTx({
      type: "incoming",
      ts: new Date(2026, 3, 24).getTime() / 1000,
      txid: "abc",
      balance: balanceMap([
        [LBTC_ID, 1n],
        [USDT_ID, 1n],
        [DEPIX_ID, 1n]
      ])
    });
    const rows = walletTxToCsvRows(tx);
    expect(rows.map(r => r[2])).toEqual(["DePix", "USDt", "L-BTC"]);
  });
});

// ---- buildWalletTxCsv ----------------------------------------------------

describe("buildWalletTxCsv", () => {
  it("emits a header row in Portuguese", () => {
    const csv = buildWalletTxCsv([]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const body = csv.slice(CSV_BOM.length);
    const firstLine = body.split("\r\n")[0];
    expect(firstLine).toBe("Data,Tipo,Ativo,Quantidade,TXID");
  });

  it("starts with UTF-8 BOM for Excel compatibility", () => {
    const csv = buildWalletTxCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
  });

  it("uses CRLF line endings and trailing newline", () => {
    const tx = makeTx({
      type: "incoming",
      ts: new Date(2026, 3, 24, 9, 5).getTime() / 1000,
      txid: "abc",
      balance: balanceMap([[DEPIX_ID, 1n]])
    });
    const csv = buildWalletTxCsv([tx]);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(CSV_BOM.length).split("\r\n");
    // header + 1 data row + trailing empty after final CRLF
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
  });

  it("includes one data row per asset when a tx touches multiple assets", () => {
    const tx = makeTx({
      type: "outgoing",
      ts: new Date(2026, 3, 24, 9, 5).getTime() / 1000,
      txid: "deadbeef",
      balance: balanceMap([[DEPIX_ID, 1n], [USDT_ID, -1n]])
    });
    const csv = buildWalletTxCsv([tx]);
    const dataLines = csv.slice(CSV_BOM.length).split("\r\n").filter(Boolean);
    // header + 2 asset rows
    expect(dataLines.length).toBe(3);
    expect(dataLines[1]).toContain("DePix");
    expect(dataLines[2]).toContain("USDt");
  });

  it("escapes formula-injection values inside rows", () => {
    // LWK txids are hex so they can't start with =/+/-/@, but a future
    // LWK change or a maliciously-constructed test stub could — exercise
    // the path end-to-end so a regression in csvEscape would flip here too.
    const tx = makeTx({
      type: "incoming",
      ts: new Date(2026, 3, 24, 9, 5).getTime() / 1000,
      txid: "=EVIL()",
      balance: balanceMap([[DEPIX_ID, 1n]])
    });
    const csv = buildWalletTxCsv([tx]);
    expect(csv).toContain(`"'=EVIL()"`);
  });

  it("yields only a header (plus trailing CRLF) for an empty tx list", () => {
    const csv = buildWalletTxCsv([]);
    const body = csv.slice(CSV_BOM.length);
    expect(body).toBe("Data,Tipo,Ativo,Quantidade,TXID\r\n");
  });
});

// ---- formatCsvFilenameDate -----------------------------------------------

describe("formatCsvFilenameDate", () => {
  it("formats as YYYY-MM-DD with zero-padded month/day", () => {
    expect(formatCsvFilenameDate(new Date(2026, 0, 7))).toBe("2026-01-07");
    expect(formatCsvFilenameDate(new Date(2026, 10, 30))).toBe("2026-11-30");
  });

  it("defaults to now (non-empty, well-formed)", () => {
    const out = formatCsvFilenameDate();
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
