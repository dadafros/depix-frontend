// @vitest-environment jsdom
/* global File, Blob */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resizeImage } from "../image-resize.js";

// jsdom doesn't support canvas.toBlob or Image loading, so we mock them

function createMockFile(name, size, type) {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

// Mock FileReader to return a data: URL
function mockFileReader() {
  const origFileReader = global.FileReader;
  global.FileReader = class {
    readAsDataURL() {
      setTimeout(() => {
        this.result = "data:image/jpeg;base64,fakedata";
        if (this.onload) this.onload();
      }, 0);
    }
  };
  return origFileReader;
}

describe("resizeImage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should reject non-image file", async () => {
    const file = createMockFile("doc.pdf", 1024, "application/pdf");
    await expect(resizeImage(file, 360)).rejects.toThrow("imagem");
  });

  it("should reject file larger than 10MB", async () => {
    const file = createMockFile("huge.jpg", 11 * 1024 * 1024, "image/jpeg");
    await expect(resizeImage(file, 360)).rejects.toThrow("10MB");
  });

  it("should reject null file", async () => {
    await expect(resizeImage(null, 360)).rejects.toThrow("imagem");
  });

  it("should reject undefined file", async () => {
    await expect(resizeImage(undefined, 360)).rejects.toThrow("imagem");
  });

  it("should accept image/jpeg", async () => {
    const file = createMockFile("photo.jpg", 5000, "image/jpeg");

    // Mock Image loading + canvas
    const mockBlob = new Blob(["fake"], { type: "image/webp" });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb) => cb(mockBlob),
    };

    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return mockCanvas;
      return document._createElement(tag);
    });

    const origFileReader = mockFileReader();

    const origImage = global.Image;
    global.Image = class {
      constructor() {
        setTimeout(() => {
          this.width = 800;
          this.height = 600;
          if (this.onload) this.onload();
        }, 0);
      }
    };

    const blob = await resizeImage(file, 360);
    expect(blob).toBeInstanceOf(Blob);
    expect(mockCanvas.width).toBe(360);
    expect(mockCanvas.height).toBe(360);

    global.Image = origImage;
    global.FileReader = origFileReader;
  });

  it("should accept image/webp", async () => {
    const file = createMockFile("photo.webp", 2000, "image/webp");

    const mockBlob = new Blob(["fake"], { type: "image/webp" });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb) => cb(mockBlob),
    };

    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return mockCanvas;
      return document._createElement(tag);
    });

    const origFileReader = mockFileReader();

    const origImage = global.Image;
    global.Image = class {
      constructor() {
        setTimeout(() => {
          this.width = 400;
          this.height = 400;
          if (this.onload) this.onload();
        }, 0);
      }
    };

    const blob = await resizeImage(file, 144);
    expect(blob).toBeInstanceOf(Blob);
    expect(mockCanvas.width).toBe(144);
    expect(mockCanvas.height).toBe(144);

    global.Image = origImage;
    global.FileReader = origFileReader;
  });

  it("should fallback to JPEG when WebP toBlob returns null", async () => {
    const file = createMockFile("photo.png", 3000, "image/png");

    const mockBlob = new Blob(["jpeg"], { type: "image/jpeg" });
    let toBlobCallCount = 0;
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb, type) => {
        toBlobCallCount++;
        if (type === "image/webp") return cb(null); // WebP not supported
        cb(mockBlob); // JPEG fallback
      },
    };

    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return mockCanvas;
      return document._createElement(tag);
    });

    const origFileReader = mockFileReader();

    const origImage = global.Image;
    global.Image = class {
      constructor() {
        setTimeout(() => {
          this.width = 500;
          this.height = 500;
          if (this.onload) this.onload();
        }, 0);
      }
    };

    const blob = await resizeImage(file, 360);
    expect(blob).toBeInstanceOf(Blob);
    expect(toBlobCallCount).toBe(2); // tried WebP, then JPEG

    global.Image = origImage;
    global.FileReader = origFileReader;
  });

  it("should handle Image load error", async () => {
    const file = createMockFile("corrupt.jpg", 1000, "image/jpeg");

    const origFileReader = mockFileReader();

    const origImage = global.Image;
    global.Image = class {
      constructor() {
        setTimeout(() => {
          if (this.onerror) this.onerror(new Error("load failed"));
        }, 0);
      }
    };

    await expect(resizeImage(file, 360)).rejects.toThrow("carregar");

    global.Image = origImage;
    global.FileReader = origFileReader;
  });

  it("should handle FileReader error", async () => {
    const file = createMockFile("bad.jpg", 1000, "image/jpeg");

    const origFileReader = global.FileReader;
    global.FileReader = class {
      readAsDataURL() {
        setTimeout(() => {
          if (this.onerror) this.onerror(new Error("read failed"));
        }, 0);
      }
    };

    await expect(resizeImage(file, 360)).rejects.toThrow("ler arquivo");

    global.FileReader = origFileReader;
  });
});
