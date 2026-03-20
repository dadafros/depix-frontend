import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock window.location.hash and addEventListener
let hashValue = "";
const listeners = {};

Object.defineProperty(global, "window", {
  value: {
    location: {
      get hash() { return hashValue; },
      set hash(v) { hashValue = v; listeners["hashchange"]?.forEach(fn => fn()); }
    },
    addEventListener: (event, fn) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    matchMedia: () => ({ matches: false })
  },
  writable: true
});

// Mock document.querySelectorAll
const sections = {};
Object.defineProperty(global, "document", {
  value: {
    querySelectorAll: (selector) => {
      if (selector === "section[data-view]") {
        return Object.values(sections);
      }
      return [];
    },
    querySelector: (selector) => {
      const match = selector.match(/section\[data-view="(\w+)"\]/);
      if (match) return sections[match[1]] || null;
      return null;
    }
  },
  writable: true
});

// Create mock sections
function createSection(name) {
  const classes = new Set(["hidden"]);
  sections[name] = {
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    }
  };
  return sections[name];
}

describe("Router", () => {
  let route, navigate, initRouter, getCurrentView;

  beforeEach(async () => {
    hashValue = "";
    for (const k in sections) delete sections[k];
    for (const k in listeners) delete listeners[k];
    createSection("landing");
    createSection("login");
    createSection("home");
    createSection("register");

    // Reset modules to get fresh route registry
    vi.resetModules();
    const mod = await import("../router.js");
    route = mod.route;
    navigate = mod.navigate;
    initRouter = mod.initRouter;
    getCurrentView = mod.getCurrentView;
  });

  it("should export all functions", () => {
    expect(route).toBeDefined();
    expect(navigate).toBeDefined();
    expect(initRouter).toBeDefined();
    expect(getCurrentView).toBeDefined();
  });

  describe("route()", () => {
    it("should register a route handler", () => {
      const handler = vi.fn();
      route("#home", handler);
      hashValue = "#home";
      initRouter();
      expect(handler).toHaveBeenCalled();
    });

    it("should accept route without handler", () => {
      route("#home", null);
      hashValue = "#home";
      expect(() => initRouter()).not.toThrow();
    });
  });

  describe("navigate()", () => {
    it("should set window.location.hash", () => {
      navigate("#home");
      expect(hashValue).toBe("#home");
    });
  });

  describe("initRouter + onHashChange", () => {
    it("should hide all sections on hash change", () => {
      hashValue = "#home";
      initRouter();

      expect(sections["login"].classList.contains("hidden")).toBe(true);
      expect(sections["register"].classList.contains("hidden")).toBe(true);
    });

    it("should show the section matching the hash", () => {
      hashValue = "#home";
      initRouter();

      expect(sections["home"].classList.contains("hidden")).toBe(false);
    });

    it("should call the registered handler for the hash", () => {
      const handler = vi.fn();
      route("#register", handler);
      hashValue = "#register";
      initRouter();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should default to #landing when hash is empty", () => {
      hashValue = "";
      initRouter();

      expect(sections["landing"].classList.contains("hidden")).toBe(false);
    });

    it("should not crash when hash has no matching section", () => {
      hashValue = "#nonexistent";
      expect(() => initRouter()).not.toThrow();
    });

    it("should respond to subsequent hash changes", () => {
      initRouter();

      hashValue = "#home";
      listeners["hashchange"]?.forEach(fn => fn());

      expect(sections["home"].classList.contains("hidden")).toBe(false);
      expect(sections["login"].classList.contains("hidden")).toBe(true);
    });
  });

  describe("getCurrentView()", () => {
    it("should return null before any navigation", () => {
      expect(getCurrentView()).toBeNull();
    });

    it("should return the current view name after navigation", () => {
      hashValue = "#home";
      initRouter();
      expect(getCurrentView()).toBe("home");
    });
  });
});
