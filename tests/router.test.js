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
  beforeEach(() => {
    hashValue = "";
    for (const k in sections) delete sections[k];
    for (const k in listeners) delete listeners[k];
    createSection("login");
    createSection("home");
    createSection("register");
  });

  it("should import router module", async () => {
    const { route, navigate, initRouter } = await import("../router.js");
    expect(route).toBeDefined();
    expect(navigate).toBeDefined();
    expect(initRouter).toBeDefined();
  });
});
