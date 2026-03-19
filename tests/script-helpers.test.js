// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { showToast, setMsg, goToAppropriateScreen } from "../script-helpers.js";

describe("setMsg", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="test-msg" class=""></div>';
  });

  it("should set text on element", () => {
    setMsg("test-msg", "Hello");
    expect(document.getElementById("test-msg").innerText).toBe("Hello");
  });

  it("should add success class when isSuccess is true", () => {
    setMsg("test-msg", "OK", true);
    expect(document.getElementById("test-msg").classList.contains("success")).toBe(true);
  });

  it("should remove success class when isSuccess is false", () => {
    document.getElementById("test-msg").classList.add("success");
    setMsg("test-msg", "Error", false);
    expect(document.getElementById("test-msg").classList.contains("success")).toBe(false);
  });

  it("should not throw for non-existent element", () => {
    expect(() => setMsg("nonexistent", "text")).not.toThrow();
  });
});

describe("showToast", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="toast" class="hidden"></div>';
    vi.useFakeTimers();
  });

  it("should set text and show the toast", () => {
    showToast("Copied!");
    const toast = document.getElementById("toast");
    expect(toast.innerText).toBe("Copied!");
    expect(toast.classList.contains("hidden")).toBe(false);
    expect(toast.classList.contains("show")).toBe(true);
    vi.useRealTimers();
  });

  it("should hide toast after timeout", () => {
    showToast("Copied!");
    const toast = document.getElementById("toast");
    vi.advanceTimersByTime(2000);
    expect(toast.classList.contains("show")).toBe(false);
    vi.advanceTimersByTime(300);
    expect(toast.classList.contains("hidden")).toBe(true);
    vi.useRealTimers();
  });
});

describe("goToAppropriateScreen", () => {
  it("should navigate to #login when not logged in", () => {
    const nav = vi.fn();
    goToAppropriateScreen({
      isLoggedIn: () => false,
      hasAddresses: () => true,
      navigate: nav
    });
    expect(nav).toHaveBeenCalledWith("#login");
  });

  it("should navigate to #home when logged in with addresses", () => {
    const nav = vi.fn();
    goToAppropriateScreen({
      isLoggedIn: () => true,
      hasAddresses: () => true,
      navigate: nav
    });
    expect(nav).toHaveBeenCalledWith("#home");
  });

  it("should navigate to #no-address when logged in without addresses", () => {
    const nav = vi.fn();
    goToAppropriateScreen({
      isLoggedIn: () => true,
      hasAddresses: () => false,
      navigate: nav
    });
    expect(nav).toHaveBeenCalledWith("#no-address");
  });
});
