// Pure utility functions extracted from script.js for testability

export const ALLOWED_QR_HOSTS = ["depix.eulen.app", "eulen.app", "api.qrserver.com"];

export function isAllowedImageUrl(url) {
  if (typeof url !== "string") return false;
  if (url.startsWith("data:image/")) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_QR_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))
    );
  } catch {
    return false;
  }
}

export function toCents(v) {
  return Math.round(
    parseFloat(v.replace("R$", "").replace(/\./g, "").replace(",", ".")) * 100
  );
}

export function formatBRL(cents) {
  return "R$ " + (cents / 100).toFixed(2).replace(".", ",");
}
