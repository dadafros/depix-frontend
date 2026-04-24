// Pure helpers for client-side CSV export of #wallet-transactions rows.
//
// The wallet is non-custodial: history lives entirely on-device, so the
// "Baixar" button generates the CSV in the browser without any backend
// round-trip. Format mirrors the backend Extrato CSV (comma delimiter,
// double-quote escaping, CRLF line terminator, UTF-8 BOM) so a user
// opening both in the same spreadsheet gets consistent parsing.
//
// Kept in a separate file from the wallet-ui.js DOM wiring so the
// escape / row / serialize logic can be unit-tested directly against
// fixtures — see tests/wallet-tx-csv.test.js.

import { getAssetByIdentifier, formatAssetAmount, DISPLAY_ORDER } from "./asset-registry.js";
import {
  safeCall,
  extractTxAssets,
  txDirection,
  txTimestampMs
} from "./wallet-tx-filter.js";

// UTF-8 BOM so Excel on Windows opens the file with the right encoding
// (ç / acentos would otherwise render as garbled bytes). Spelled as an
// escape sequence instead of the raw byte so editors / diff tools render
// the source legibly — the literal char is zero-width and invisible.
export const CSV_BOM = "\uFEFF";

// Quote + escape a single CSV cell. Neutralises spreadsheet formula
// injection: values starting with =, +, -, @, tab or CR are prefixed with
// a single quote inside the quoted cell so Excel / Sheets treat them as
// literal text instead of evaluating them. Mirrors the backend
// `csvEscape` in api/_lib/routes/reports.js for cross-surface consistency.
export function csvEscape(value) {
  if (value === null || value === undefined || value === "") return "";
  const s = String(value);
  const needsPrefix = /^[=+\-@\t\r]/.test(s);
  const needsQuote = needsPrefix || s.includes(",") || s.includes('"') || s.includes("\n");
  if (needsQuote) {
    return `"${needsPrefix ? "'" : ""}${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// Render a wallet tx timestamp (epoch ms, from txTimestampMs) as the
// `dd/mm/yyyy hh:mm` format a pt-BR reader recognises from the Extrato PDF.
// Returns "" for missing / invalid input — the caller decides whether to
// emit the row with an empty date cell or skip it entirely.
export function formatCsvDateTime(ms) {
  if (ms === null || ms === undefined) return "";
  try {
    const dt = new Date(ms);
    if (!Number.isFinite(dt.getTime())) return "";
    const pad = n => String(n).padStart(2, "0");
    return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  } catch {
    return "";
  }
}

// Expand one LWK tx into one CSV row per asset it touches. Multi-asset
// swaps (e.g. sending USDt and receiving L-BTC in the same tx) are split
// so each row has a single scalar quantity — spreadsheets can then
// aggregate by asset/direction without having to parse a composite cell.
// A tx with zero known assets still emits one row (date/dir/txid only)
// so it does not silently disappear from the export.
export function walletTxToCsvRows(tx) {
  const ms = txTimestampMs(tx);
  const dateStr = formatCsvDateTime(ms);
  const dir = txDirection(tx);
  const dirLabel = dir === "in" ? "Recebido" : dir === "out" ? "Enviado" : "Outro";
  const txid = safeCall(tx, "txid");
  const txidStr = (txid && typeof txid.toString === "function")
    ? txid.toString()
    : String(txid ?? "");
  const assets = extractTxAssets(tx);
  const rows = [];
  // Iterate in DISPLAY_ORDER (DePix → USDt → L-BTC) rather than Object.keys
  // order so a multi-asset tx renders deterministically across exports —
  // Object.keys follows LWK Map insertion order, which can shift between
  // syncs or wasm versions. Unknown/extra asset ids are appended after
  // the known ones (but still filtered out if not in asset-registry).
  const seen = new Set();
  for (const asset of DISPLAY_ORDER) {
    if (!(asset.id in assets)) continue;
    seen.add(asset.id);
    const sats = assets[asset.id];
    const absStr = formatAssetAmount(sats < 0n ? -sats : sats, asset);
    const signed = sats < 0n ? `-${absStr}` : absStr;
    rows.push([dateStr, dirLabel, asset.symbol, signed, txidStr]);
  }
  for (const assetId of Object.keys(assets)) {
    if (seen.has(assetId)) continue;
    const asset = getAssetByIdentifier(assetId);
    if (!asset) continue;
    const sats = assets[assetId];
    const absStr = formatAssetAmount(sats < 0n ? -sats : sats, asset);
    const signed = sats < 0n ? `-${absStr}` : absStr;
    rows.push([dateStr, dirLabel, asset.symbol, signed, txidStr]);
  }
  if (rows.length === 0) {
    rows.push([dateStr, dirLabel, "", "", txidStr]);
  }
  return rows;
}

// Serialise an array of LWK txs to a CSV string. The column order mirrors
// the on-screen wallet-tx row (Date · Direction · Asset · Amount · TXID)
// so a user comparing the export side-by-side with the UI reads the same
// shape. BOM + CRLF line endings make Excel-on-Windows happy.
export function buildWalletTxCsv(txs) {
  const header = ["Data", "Tipo", "Ativo", "Quantidade", "TXID"];
  const lines = [header.map(csvEscape).join(",")];
  for (const tx of txs) {
    for (const row of walletTxToCsvRows(tx)) {
      lines.push(row.map(csvEscape).join(","));
    }
  }
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

// YYYY-MM-DD stamp for the default filename. Extracted so tests can feed
// a frozen `now` Date instead of stubbing Date globally.
export function formatCsvFilenameDate(now = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
