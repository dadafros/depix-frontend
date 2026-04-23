/**
 * Print-ready QR helpers — frontend-only.
 *
 * Functions that generate browser-downloadable images (canvas → data URL) live
 * here instead of qr.js because they have no use in server-rendered pages.
 * qr.js is kept as a shared core byte-identical between depix-frontend and
 * depix-backend/public — see the SYNC NOTICE in qr.js for details.
 */

import { _generateQR } from "./qr.js";

/**
 * Generate a print-ready QR code as a data URL (white bg, rounded dots, centered logo).
 * Same style as the checkout page template. Returns a Promise<string> (data URL).
 */
export function renderPrintableQr(text) {
  return new Promise((resolve, reject) => {
    try {
      const { matrix, size } = _generateQR(text, 3); // ECC H
      const px = 600;
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");

      const qz = 4, total = size + qz * 2, unit = px / total, off = qz * unit;

      // White background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, px, px);

      // Rounded dots
      ctx.fillStyle = "#1a202c";
      const dot = unit * 0.44;
      ctx.beginPath();
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
          if (matrix[r][c]) {
            const x = off + (c + 0.5) * unit, y = off + (r + 0.5) * unit;
            ctx.moveTo(x + dot, y);
            ctx.arc(x, y, dot, 0, Math.PI * 2);
          }
      ctx.fill();

      // White pad behind logo
      const ls = Math.round(px * 0.18);
      const cx = px / 2, cy = px / 2;
      const pad = 10;
      const rr = ls / 2 + pad, cornerR = rr * 0.3;
      ctx.beginPath();
      ctx.roundRect(cx - rr, cy - rr, rr * 2, rr * 2, cornerR);
      ctx.fillStyle = "#ffffff";
      ctx.fill();

      // Logo
      const logo = new Image();
      logo.onload = () => {
        ctx.save();
        const cr = ls * 0.15;
        ctx.beginPath();
        ctx.roundRect(cx - ls / 2, cy - ls / 2, ls, ls, cr);
        ctx.clip();
        const inset = ls * 0.08;
        ctx.drawImage(logo, cx - ls / 2 - inset, cy - ls / 2 - inset, ls + inset * 2, ls + inset * 2);
        ctx.restore();
        resolve(canvas.toDataURL("image/png"));
      };
      logo.onerror = () => resolve(canvas.toDataURL("image/png"));
      logo.src = "./icon-192.png";
    } catch (e) {
      reject(e);
    }
  });
}
