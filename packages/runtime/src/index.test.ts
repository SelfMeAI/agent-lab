import { describe, expect, it } from "vitest";
import { AdapterRegistry, type HarnessAdapter } from "./index";

const adapter: HarnessAdapter = {
  id: "sample",
  label: "Sample",
  probe: async () => ({ id: "sample", label: "Sample", availability: "ready" }),
  start: async () => {},
  getResumeRef: () => null,
  send: async () => {},
  steer: async () => {},
  cancel: async () => {},
  respondApproval: async () => {},
  stop: async () => {},
  onEvent: () => () => {},
};

describe("AdapterRegistry", () => {
  it("lists registered adapters", async () => {
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(await registry.list()).toEqual([
      { id: "sample", label: "Sample", availability: "ready" },
    ]);
  });

  it("rejects duplicate adapter ids", () => {
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(() => registry.register(adapter)).toThrow("already registered");
  });
});
