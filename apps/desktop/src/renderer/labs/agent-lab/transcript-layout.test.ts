import { afterEach, describe, expect, it, vi } from "vitest";
import { observeTranscriptLayout } from "./transcript-layout";

afterEach(() => vi.unstubAllGlobals());

function setup(follow = true) {
  let resize: (() => void) | undefined;
  let toggle: (() => void) | undefined;
  let nextFrame = 0;
  const frames = new Map<number, () => void>();
  const disconnect = vi.fn();
  vi.stubGlobal("window", {
    requestAnimationFrame: vi.fn((cb: () => void) => { frames.set(++nextFrame, cb); return nextFrame; }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const output = {
    scrollHeight: 1200, clientHeight: 400, scrollTop: 800,
    addEventListener: vi.fn((_name: string, callback: () => void) => { toggle = callback; }),
    removeEventListener: vi.fn(),
  };
  const following = { current: follow }, position = vi.fn();
  const cleanup = observeTranscriptLayout(output as unknown as HTMLElement, following, position);
  const flush = () => { const batch = [...frames.values()]; frames.clear(); for (const cb of batch) cb(); };
  return { output, following, position, resize: () => resize!(), toggle: () => toggle!(), flush, frames, disconnect, cleanup };
}

describe("transcript layout anchoring", () => {
  it("keeps latest output visible when queues, multiline drafts or window size shrink the viewport", () => {
    const t = setup(); t.output.clientHeight = 180; t.resize(); t.flush();
    expect(t.output.scrollTop).toBe(1200); expect(t.position).toHaveBeenLastCalledWith(true);
    t.output.clientHeight = 500; t.resize(); t.flush();
    expect(t.position).toHaveBeenLastCalledWith(true); t.cleanup();
  });

  it("preserves a history reader's scroll position on resize and tool expansion", () => {
    const t = setup(false); t.output.scrollTop = 240; t.output.clientHeight = 180;
    t.resize(); t.flush();
    expect(t.output.scrollTop).toBe(240); expect(t.position).toHaveBeenLastCalledWith(false);
    t.output.scrollHeight = 2000; t.toggle(); t.flush();
    expect(t.output.scrollTop).toBe(240); t.cleanup();
  });

  it("coalesces tool and viewport changes and cancels pending callbacks when switching sessions", () => {
    const t = setup(); t.output.scrollHeight = 2000;
    t.resize(); t.toggle(); t.resize(); expect(t.frames.size).toBe(1);
    t.flush(); expect(t.position).toHaveBeenCalledTimes(1);
    expect(t.output.addEventListener).toHaveBeenCalledWith("toggle", expect.any(Function), true);
    t.resize(); t.cleanup(); t.flush();
    expect(t.disconnect).toHaveBeenCalledOnce(); expect(t.frames.size).toBe(0);
    expect(t.position).toHaveBeenCalledTimes(1);
  });
});
