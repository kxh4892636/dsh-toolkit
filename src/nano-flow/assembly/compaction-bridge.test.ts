import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearCompactionBridge,
  getCompactionBridge,
  setCompactionBridge,
} from "./compaction-bridge.js";

afterEach(() => {
  clearCompactionBridge();
});

const signal = new AbortController().signal;

describe("compaction bridge", () => {
  it("没登记时读不到", () => {
    expect(getCompactionBridge()).toBeUndefined();
  });

  it("登记后原样读回，传给桥的参数就是调用方的参数", async () => {
    const engine = { compactNow: vi.fn(async (_agent: unknown, _signal: AbortSignal) => "done") };
    setCompactionBridge((agent, inner) => engine.compactNow(agent, inner));
    const bridge = getCompactionBridge();
    expect(bridge).toBeTypeOf("function");
    const agent = { id: "session-1" };
    await expect(bridge?.(agent, signal)).resolves.toBe("done");
    expect(engine.compactNow).toHaveBeenCalledWith(agent, signal);
  });

  it("clear 之后读不到", () => {
    setCompactionBridge(() => Promise.resolve(null));
    clearCompactionBridge();
    expect(getCompactionBridge()).toBeUndefined();
  });

  it("撤销只清自己那一次，后登记的桥不会被先卸载的 mount 抹掉", async () => {
    const first = setCompactionBridge(() => Promise.resolve("first"));
    setCompactionBridge(() => Promise.resolve("second"));
    first();
    await expect(getCompactionBridge()?.(null, signal)).resolves.toBe("second");
    clearCompactionBridge();
    expect(getCompactionBridge()).toBeUndefined();
  });
});
