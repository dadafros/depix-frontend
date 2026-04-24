// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load index.html once and parse it into jsdom via document.documentElement.
// We only care about the menu + modal markup — behavioral tests live in
// wallet-integrated-gate.test.js (pure) and menu-navigation.spec.js (Playwright).
let doc;
beforeAll(() => {
  const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyInner = match ? match[1] : html;
  document.body.innerHTML = bodyInner;
  doc = document;
});

describe("Side menu structure", () => {
  it("exposes the unified 'Minha Carteira' accordion with 2 sub-items", () => {
    const items = doc.querySelectorAll("#menu-overlay .menu-section-items .menu-item");
    const integrada = doc.getElementById("menu-carteira-integrada");
    const externa = doc.getElementById("menu-carteira-externa");
    expect(integrada).not.toBeNull();
    expect(externa).not.toBeNull();
    expect(integrada.textContent.trim()).toBe("Carteira Integrada");
    expect(externa.textContent.trim()).toBe("Carteira Externa");
    // Both sub-items must live inside a sibling `.menu-section-items` of a
    // `.menu-section-toggle` labelled "Minha Carteira".
    const section = integrada.closest(".menu-section");
    expect(section).not.toBeNull();
    const heading = section.querySelector(".menu-section-toggle");
    expect(heading.textContent.trim()).toBe("Minha Carteira");
    // `externa` lives in the same section.
    expect(section.contains(externa)).toBe(true);
    // Smoke: the whole menu still has other sections + the sub-menu we added.
    expect(items.length).toBeGreaterThan(0);
  });

  it("no longer exposes the legacy top-level 'Endereços' section", () => {
    const headings = Array.from(doc.querySelectorAll("#menu-overlay .menu-section-toggle"));
    const labels = headings.map(h => h.textContent.trim());
    expect(labels).not.toContain("Endereços");
    // The old top-level menu-items must be gone.
    expect(doc.getElementById("menu-select-addr")).toBeNull();
    expect(doc.getElementById("menu-add-addr")).toBeNull();
    // The old single-link "Carteira Liquid" must be gone (now the accordion heading).
    expect(doc.getElementById("menu-wallet")).toBeNull();
  });
});

describe("Carteira Externa modal", () => {
  it("replaces the legacy split modals with a single unified modal", () => {
    expect(doc.getElementById("select-addr-modal")).toBeNull();
    expect(doc.getElementById("add-addr-modal")).toBeNull();
    const modal = doc.getElementById("external-wallet-modal");
    expect(modal).not.toBeNull();
    expect(modal.classList.contains("modal")).toBe(true);
    expect(modal.classList.contains("hidden")).toBe(true);
  });

  it("includes the add form + list container + commit/cancel footer", () => {
    const modal = doc.getElementById("external-wallet-modal");
    // The educational block now lives ONLY in the intro modal
    // (external-wallet-intro-modal) to avoid UX duplication.
    expect(modal.querySelector(".wallet-info-block")).toBeNull();
    expect(doc.getElementById("new-addr-input")).not.toBeNull();
    expect(doc.getElementById("btn-save-addr")).not.toBeNull();
    expect(doc.getElementById("addr-list")).not.toBeNull();
    // Footer has a Commit (Usar Carteira Externa) + Cancel pair; the legacy
    // single Fechar button was removed when the modal became a commit step.
    expect(doc.getElementById("external-wallet-commit")).not.toBeNull();
    expect(doc.getElementById("external-wallet-cancel")).not.toBeNull();
    expect(doc.getElementById("close-external-wallet")).toBeNull();
  });

  it("intro modal exposes educational copy + 2 CTAs (no redundant Fechar)", () => {
    const intro = doc.getElementById("external-wallet-intro-modal");
    expect(intro).not.toBeNull();
    const info = intro.querySelector(".wallet-info-block");
    expect(info).not.toBeNull();
    expect(info.textContent).toMatch(/SideSwap|Jade|Ledger|Green/);
    expect(doc.getElementById("external-wallet-intro-continue")).not.toBeNull();
    expect(doc.getElementById("external-wallet-intro-proceed")).not.toBeNull();
    expect(doc.getElementById("close-external-wallet-intro")).toBeNull();
  });
});

describe("Carteira Integrada modal", () => {
  it("exposes the expected CTA buttons and maintenance notice", () => {
    const modal = doc.getElementById("integrated-wallet-modal");
    expect(modal).not.toBeNull();
    expect(modal.classList.contains("modal")).toBe(true);
    expect(modal.classList.contains("hidden")).toBe(true);
    expect(doc.getElementById("integrated-wallet-access")).not.toBeNull();
    expect(doc.getElementById("integrated-wallet-create")).not.toBeNull();
    expect(doc.getElementById("integrated-wallet-restore")).not.toBeNull();
    expect(doc.getElementById("integrated-wallet-maintenance")).not.toBeNull();
    expect(doc.getElementById("close-integrated-wallet")).not.toBeNull();
  });

  it("ships educational blocks covering non-custodial + how-it-works + what DepixApp does not", () => {
    const modal = doc.getElementById("integrated-wallet-modal");
    const blocks = modal.querySelectorAll(".wallet-info-block");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const text = modal.textContent.toLowerCase();
    expect(text).toMatch(/não-custodial|nao-custodial/);
    expect(text).toContain("12 palavras");
    expect(text).toMatch(/não.*acesso|nao.*acesso/);
  });

  it("starts with all CTAs hidden (state is populated on open)", () => {
    const access = doc.getElementById("integrated-wallet-access");
    const create = doc.getElementById("integrated-wallet-create");
    const restore = doc.getElementById("integrated-wallet-restore");
    expect(access.classList.contains("hidden")).toBe(true);
    expect(create.classList.contains("hidden")).toBe(true);
    expect(restore.classList.contains("hidden")).toBe(true);
  });
});
