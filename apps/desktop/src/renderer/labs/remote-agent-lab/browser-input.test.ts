import { describe, expect, it } from "vitest";
import { browserInputModifiers, browserInputPoint } from "./browser-input";

describe("remote browser human input", () => {
  const box = { left: 10, top: 20, width: 400, height: 400 }, raster = { width: 1000, height: 500 }, viewport = { width: 2000, height: 1000 };
  it("maps centered letterboxed/downscaled frames to the real CSS viewport", () => {
    expect(browserInputPoint(210, 220, box, raster, viewport)).toEqual({ x: 1000, y: 500 });
    expect(browserInputPoint(10, 120, box, raster, viewport)).toEqual({ x: 0, y: 0 });
    expect(browserInputPoint(210, 30, box, raster, viewport)).toBeUndefined();
    expect(browserInputPoint(410, 220, box, raster, viewport)).toBeUndefined();
    expect(browserInputPoint(800, 900, box, raster, viewport, true)).toEqual({ x: 1999, y: 999 });
    expect(browserInputPoint(0, 0, { ...box, width: 0 }, raster, viewport)).toBeUndefined();
  });
  it("translates macOS Command and preserves the native input modifier mask", () => {
    const plain = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(browserInputModifiers(plain)).toBe(0);
    expect(browserInputModifiers({ ...plain, metaKey: true })).toBe(2);
    expect(browserInputModifiers({ ...plain, ctrlKey: true, metaKey: true })).toBe(2);
    expect(browserInputModifiers({ ...plain, altKey: true, shiftKey: true })).toBe(9);
  });
});
