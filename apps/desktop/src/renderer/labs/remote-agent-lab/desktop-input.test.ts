import { describe, expect, it, vi } from "vitest";
import { desktopInputBoundary } from "./desktop-input";

function fixture() {
  const canvas = { blur: vi.fn() };
  class Mouse extends Event { buttons: number; clientX: number; clientY: number;
    constructor(type: string, options: MouseEventInit = {}) { super(type); this.buttons = options.buttons ?? 0; this.clientX = options.clientX ?? 0; this.clientY = options.clientY ?? 0; }
  }
  const window = Object.assign(new EventTarget(), { MouseEvent: Mouse });
  const document = Object.assign(new EventTarget(), { defaultView: window, captureElement: null as unknown, activeElement: canvas, visibilityState: "visible" });
  const host = { ownerDocument: document, contains: (element: unknown) => element === canvas } as unknown as HTMLElement;
  const mouseup = vi.fn((_event: Event) => { document.captureElement = null; }); window.addEventListener("mouseup", mouseup);
  const boundary = desktopInputBoundary(host);
  return { canvas, window, document, host, mouseup, boundary };
}
describe("desktop input boundary", () => {
  it("releases a stale owned capture on a pointer move with no pressed buttons", () => {
    const f = fixture(); f.document.captureElement = f.canvas;
    f.window.dispatchEvent(Object.assign(new Event("pointermove"), { buttons: 0, clientX: 200, clientY: 100 }));
    expect(f.mouseup).toHaveBeenCalledOnce();
    expect(f.mouseup.mock.calls[0]?.[0]).toMatchObject({ buttons: 0, clientX: 200, clientY: 100 });
    f.boundary.dispose();
  });
  it("keeps normal drags captured, and never releases another viewer's capture", () => {
    const f = fixture(); f.document.captureElement = f.canvas;
    f.window.dispatchEvent(Object.assign(new Event("pointermove"), { buttons: 1, clientX: 20, clientY: 10 }));
    expect(f.mouseup).not.toHaveBeenCalled();
    f.document.captureElement = {};
    f.boundary.release(); expect(f.mouseup).not.toHaveBeenCalled(); f.boundary.dispose();
  });
  it("releases mouse and keyboard focus on window blur and removes listeners on unmount", () => {
    const f = fixture(); f.document.captureElement = f.canvas;
    f.window.dispatchEvent(new Event("blur"));
    expect(f.mouseup).toHaveBeenCalledOnce(); expect(f.canvas.blur).toHaveBeenCalledOnce();
    f.boundary.dispose(); f.mouseup.mockClear(); f.canvas.blur.mockClear(); f.document.captureElement = f.canvas;
    f.window.dispatchEvent(new Event("blur"));
    expect(f.mouseup).not.toHaveBeenCalled(); expect(f.canvas.blur).not.toHaveBeenCalled();
  });
  it("releases an owned capture before the document becomes hidden", () => {
    const f = fixture(); f.document.captureElement = f.canvas; f.document.visibilityState = "hidden";
    f.document.dispatchEvent(new Event("visibilitychange"));
    expect(f.mouseup).toHaveBeenCalledOnce(); f.boundary.dispose();
  });
});
