import { describe, expect, it } from "vite-plus/test";
import { findUndoTarget, type UndoSessionEvent } from "./turn-boundary.js";

/** 表面事件类型：真实日志里这些事件都带 `surfaceOp`。 */
const SURFACE_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

/** 按真实日志的形状造事件：消息事件默认追加到表面尾部。 */
const events = (spec: readonly [string, unknown?][]): UndoSessionEvent[] =>
  spec.map(([type, data], seq) => ({
    type,
    seq,
    ...(data === undefined ? {} : { data }),
    ...(SURFACE_TYPES.has(type) ? { surfaceOp: "append" } : {}),
  }));

const userMessage = (text: string, kind = "user"): unknown => ({
  role: "user",
  content: [{ type: "text", text }],
  source: { kind },
});

const assistantMessage = (text: string): unknown => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("findUndoTarget", () => {
  it("returns undefined for an empty or turn-less log", () => {
    expect(findUndoTarget([])).toBeUndefined();
    expect(findUndoTarget(events([["session/title", {}]]))).toBeUndefined();
  });

  it("refuses to undo the first turn", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("你好")],
      ["assistant/message", assistantMessage("在")],
      ["turn/end", { turn: 1 }],
    ]);
    expect(findUndoTarget(log)).toBeUndefined();
  });

  it("takes the last turn's user message as the recall boundary", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("第一轮")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["user/message", userMessage("第二轮")],
    ]);
    expect(findUndoTarget(log)).toEqual({
      turn: 2,
      turnStartSeq: 3,
      boundarySeq: 4,
      prompt: "第二轮",
    });
  });

  it("handles a running turn after several completed turns", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("a")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["user/message", userMessage("b")],
      ["turn/end", { turn: 2 }],
      ["turn/start", { turn: 3 }],
      ["user/message", userMessage("c")],
      ["step/start", { turn: 3, step: 1 }],
    ]);
    const target = findUndoTarget(log);
    expect(target?.turn).toBe(3);
    expect(target?.turnStartSeq).toBe(6);
    expect(target?.boundarySeq).toBe(7);
    expect(target?.prompt).toBe("c");
  });

  it("joins multiple user-authored messages and skips injected context", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("one")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["user/message", userMessage("two")],
      [
        "user/message",
        {
          role: "user",
          content: [{ type: "text", text: "运行时上下文" }],
          source: { kind: "runtime-context" },
        },
      ],
      ["user/message", userMessage("steer")],
    ]);
    const target = findUndoTarget(log);
    // 切点停在第一条用户消息上：注入的上下文与追加的引导消息都随整段一起遮蔽。
    expect(target?.boundarySeq).toBe(4);
    expect(target?.prompt).toBe("two\n\nsteer");
  });

  it("ignores non-text parts and messages without a source", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("x")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["user/message", { content: [{ type: "image" }, { type: "text", text: "png" }] }],
    ]);
    expect(findUndoTarget(log)?.prompt).toBe("png");
  });

  it("falls back to the turn's assistant message when it carries no user text", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("x")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["assistant/message", assistantMessage("自动续跑")],
    ]);
    const target = findUndoTarget(log);
    expect(target?.boundarySeq).toBe(4);
    expect(target?.prompt).toBe("");
  });

  it("returns undefined when the last turn carries no surface message", () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("x")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["turn/end", { turn: 2 }],
    ]);
    expect(findUndoTarget(log)).toBeUndefined();
  });

  it("ignores messages that are surface replacements, not appends", () => {
    const log: UndoSessionEvent[] = [
      ...events([
        ["turn/start", { turn: 1 }],
        ["user/message", userMessage("x")],
        ["turn/end", { turn: 1 }],
        ["turn/start", { turn: 2 }],
      ]),
      {
        type: "user/message",
        seq: 4,
        data: userMessage("种子"),
        surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 },
      },
    ];
    expect(findUndoTarget(log)).toBeUndefined();
  });

  it("keeps the turn number declared by turn/start", () => {
    const log = events([
      ["turn/start", { turn: 4 }],
      ["user/message", userMessage("a")],
      ["turn/end", { turn: 4 }],
      ["turn/start", { turn: 5 }],
      ["user/message", userMessage("b")],
    ]);
    expect(findUndoTarget(log)?.turn).toBe(5);
  });
});
