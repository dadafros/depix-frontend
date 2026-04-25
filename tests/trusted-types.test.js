import { describe, it, expect, afterEach } from "vitest";

// Each test imports the module fresh via vitest's reset hook so the
// module-top-level policy registration runs against the configured
// globalThis.trustedTypes (or absence thereof). Without resetModules the
// first import wins and later mutations of globalThis.trustedTypes have
// no effect on the cached `policy` reference.

afterEach(async () => {
  await import("vitest").then(v => v.vi.resetModules());
  delete globalThis.trustedTypes;
});

describe("trusted-types.js — toTrustedHTML", () => {
  it("returns the input unchanged when Trusted Types is unavailable", async () => {
    delete globalThis.trustedTypes;
    const { toTrustedHTML } = await import("../trusted-types.js");
    expect(toTrustedHTML("<b>x</b>")).toBe("<b>x</b>");
    expect(toTrustedHTML("")).toBe("");
  });

  it("registers the 'depix' policy and routes through it when Trusted Types exists", async () => {
    let capturedHtml = null;
    let capturedPolicyName = null;
    globalThis.trustedTypes = {
      createPolicy(name, def) {
        capturedPolicyName = name;
        return {
          createHTML: html => {
            capturedHtml = html;
            // Real browsers return a TrustedHTML; for the test we return a
            // distinct sentinel object so we can assert "this came from the
            // policy" instead of "this is the raw string".
            return { __trusted: true, raw: def.createHTML(html) };
          }
        };
      }
    };
    const { toTrustedHTML } = await import("../trusted-types.js");
    expect(capturedPolicyName).toBe("depix");
    const out = toTrustedHTML("<i>hi</i>");
    expect(capturedHtml).toBe("<i>hi</i>");
    expect(out).toEqual({ __trusted: true, raw: "<i>hi</i>" });
  });

  it("falls back to identity when createPolicy throws (e.g. duplicate without 'allow-duplicates')", async () => {
    globalThis.trustedTypes = {
      createPolicy() { throw new Error("policy already exists"); }
    };
    const { toTrustedHTML } = await import("../trusted-types.js");
    expect(toTrustedHTML("<b>x</b>")).toBe("<b>x</b>");
  });

  it("setInnerHTML wraps the assignment and tolerates a null target", async () => {
    delete globalThis.trustedTypes;
    const { setInnerHTML } = await import("../trusted-types.js");
    const el = { innerHTML: "" };
    setInnerHTML(el, "<span>ok</span>");
    expect(el.innerHTML).toBe("<span>ok</span>");
    // Null target must not throw — call sites do `setInnerHTML(q("x"), …)`
    // where `q` may return null when the modal markup hasn't rendered yet.
    expect(() => setInnerHTML(null, "<b>nope</b>")).not.toThrow();
  });

  it("insertHTML wraps the call and tolerates a null target", async () => {
    delete globalThis.trustedTypes;
    const { insertHTML } = await import("../trusted-types.js");
    const calls = [];
    const el = {
      insertAdjacentHTML(pos, html) { calls.push([pos, html]); }
    };
    insertHTML(el, "beforeend", "<b>row</b>");
    expect(calls).toEqual([["beforeend", "<b>row</b>"]]);
    expect(() => insertHTML(null, "beforeend", "<b>x</b>")).not.toThrow();
  });
});
