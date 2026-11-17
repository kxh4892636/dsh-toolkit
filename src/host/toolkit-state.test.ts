import { describe, expect, it } from "vite-plus/test";
import {
  emptyToolkitState,
  nodeToolkitStateIo,
  parseToolkitState,
  serializeToolkitState,
  ToolkitStateStore,
  type ToolkitStateIo,
} from "./toolkit-state.js";

const memoryIo = (initial?: string): ToolkitStateIo & { readonly text: () => string } => {
  let text = initial;
  return {
    async read() {
      return text;
    },
    async write(next) {
      text = next;
    },
    text() {
      return text ?? "";
    },
  };
};

describe("parseToolkitState", () => {
  it("falls back to the empty state for missing or broken content", () => {
    expect(parseToolkitState(undefined)).toEqual(emptyToolkitState());
    expect(parseToolkitState("   ")).toEqual(emptyToolkitState());
    expect(parseToolkitState("{oops")).toEqual(emptyToolkitState());
    expect(parseToolkitState("null")).toEqual(emptyToolkitState());
    expect(parseToolkitState('{"tools":[]}')).toEqual(emptyToolkitState());
  });

  it("keeps boolean switches and drops unknown value shapes", () => {
    const doc = parseToolkitState('{"tools":{"a":true,"b":false,"c":"yes","d":null}}');
    expect(doc.tools).toEqual({ a: true, b: false });
  });
});

describe("serializeToolkitState", () => {
  it("round-trips through the parser", () => {
    const doc = {
      version: 1,
      tools: { "nested-skill": false },
    };
    expect(parseToolkitState(serializeToolkitState(doc))).toEqual(doc);
  });
});

describe("nodeToolkitStateIo", () => {
  it("returns undefined when the file is missing", async () => {
    const io = nodeToolkitStateIo(`${process.cwd()}/.tmp-missing/toolkit/state.json`);
    await expect(io.read()).resolves.toBeUndefined();
  });
});

describe("ToolkitStateStore", () => {
  it("loads defaults and persists switches", async () => {
    const io = memoryIo();
    const store = new ToolkitStateStore(io);
    await store.load();
    expect(store.snapshot().tools).toEqual({});

    await store.setTool("nested-skill", false);
    expect(store.snapshot().tools).toEqual({ "nested-skill": false });
    expect(io.text()).toContain('"nested-skill": false');
  });

  it("serializes concurrent writes instead of losing them", async () => {
    const store = new ToolkitStateStore(memoryIo());
    await store.load();
    await Promise.all([store.setTool("a", true), store.setTool("b", true)]);
    expect(store.snapshot().tools).toEqual({ a: true, b: true });
  });

  it("survives a failing write on load", async () => {
    const io: ToolkitStateIo = {
      async read() {
        throw new Error("disk on fire");
      },
      async write() {},
    };
    const store = new ToolkitStateStore(io);
    await expect(store.load()).rejects.toThrow("disk on fire");
    expect(store.snapshot()).toEqual(emptyToolkitState());
  });
});
