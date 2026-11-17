import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_NANO_FLOW_SETTINGS } from "../../contract.js";
import {
  createRotation,
  LAST_OUTPUT_TAG,
  lastAssistantText,
  selectedPreset,
  truncateTail,
  type PromptRequestLike,
  type RotationSession,
  type SurfaceSession,
} from "./rotate.js";
import type { HostServices } from "./services.js";

type Pressure = {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
};

type EventLike = { type: string; seq?: number; data?: unknown };

type Appended = { type: string; data: Record<string, unknown>; opts?: Record<string, unknown> };

const signal = new AbortController().signal;

/** 一轮事件：turn/start + 若干 assistant 消息 + turn/end。 */
const turnEvents = (
  turn: number,
  messages: readonly (readonly { type: string; text?: string }[])[],
  from = 1,
): readonly EventLike[] => {
  const events: EventLike[] = [{ type: "turn/start", seq: from, data: { turn } }];
  for (const content of messages) {
    events.push({
      type: "assistant/message",
      seq: from + events.length,
      data: { turn, message: { content } },
    });
  }
  events.push({
    type: "turn/end",
    seq: from + events.length,
    data: { turn, reason: { kind: "completed" } },
  });
  return events;
};

/** 可写会话：表面固定为「系统提示 + 两条消息」，append 记账并推进表面与日志。 */
const makeSession = (
  options: {
    id?: string;
    preset?: string;
    header?: RotationSession["header"];
    events?: readonly EventLike[];
    surfaceNodes?: readonly number[];
    failAppend?: boolean;
  } = {},
): SurfaceSession & { appended: Appended[]; nodes: number[]; log: EventLike[] } => {
  const nodes = [...(options.surfaceNodes ?? [1, 3, 5])];
  const appended: Appended[] = [];
  const log: EventLike[] = [
    { type: "agent-preset/selected", seq: 0, data: { agentPreset: options.preset ?? "nano-flow" } },
    ...(options.events ?? []),
  ];
  let next = 100;
  return {
    id: options.id ?? "session-1",
    header: { cwd: "C:\\work", ...options.header },
    appended,
    nodes,
    log,
    surface: {
      get nodes() {
        return [...nodes];
      },
    },
    append: (type: string, data: unknown, opts?: unknown) => {
      if (options.failAppend === true) throw new Error("append rejected");
      const seq = next;
      next += 1;
      appended.push({
        type,
        data: data as Record<string, unknown>,
        ...(opts === undefined ? {} : { opts: opts as Record<string, unknown> }),
      });
      nodes.push(seq);
      log.push({ type, seq, data });
      return { seq };
    },
    snapshotEvents: () => log,
  };
};

const makeHarness = (
  options: {
    autoCheck?: (params: {
      sessionId: string;
      workspace: string;
    }) => Promise<{ readonly text: string } | undefined>;
    boundPlan?: (params: { sessionId: string; workspace: string }) => Promise<string | undefined>;
    session?: ReturnType<typeof makeSession>;
  } = {},
) => {
  let pressure: Pressure = { pressureTokens: 10, contextWindow: 1000 };
  const session = options.session ?? makeSession();
  const others = new Map<string, RotationSession>([
    [session.id, session],
    ["session-other", makeSession({ id: "session-other", preset: "standard" })],
  ]);
  const originalPrompt = vi.fn(async (_request: PromptRequestLike, _signal?: AbortSignal) => ({
    accepted: true,
  }));
  const flush = vi.fn(async () => true);
  const warn = vi.fn();
  const controller = { prompt: originalPrompt };
  const services = {
    get: (name: string) => {
      if (name === "tokenMeter") {
        return {
          contextPressure: () => pressure,
          measure: () => ({
            // 路由价（tokens）与固定启发式价（heuristicTokens）故意不同：
            // 遮蔽价协议要求后者，用错会折叠出对不上的上下文面积。
            nodes: session.surface.nodes.map((seq) => ({
              seq,
              tokens: 100,
              heuristicTokens: 40,
            })),
          }),
        };
      }
      if (name === "sessionController") return controller;
      if (name === "sessions") return { flush };
      return undefined;
    },
    logger: { warn },
  } as unknown as HostServices;
  const rotation = createRotation({
    services,
    config: { presetId: "nano-flow" },
    domainRoot: ".agents/domains",
    settings: () => ({ ...DEFAULT_NANO_FLOW_SETTINGS, rotateAt: 0.618 }),
    sessionOf: (id) => others.get(id),
    ...(options.autoCheck === undefined ? {} : { autoCheck: options.autoCheck }),
    ...(options.boundPlan === undefined ? {} : { boundPlan: options.boundPlan }),
  });
  const dispose = rotation.attach();
  const request = (overrides: Partial<PromptRequestLike> = {}): PromptRequestLike => ({
    requestId: "request-1",
    sessionId: session.id,
    mode: "queue",
    content: [{ type: "text", text: "用户消息" }],
    ...overrides,
  });
  const send = (overrides: Partial<PromptRequestLike> = {}): Promise<{ accepted: boolean }> =>
    controller.prompt(request(overrides), signal);
  return {
    controller,
    session,
    originalPrompt,
    flush,
    warn,
    dispose,
    send,
    setPressure: (next: Pressure) => (pressure = next),
  };
};

const textsOf = (request: PromptRequestLike | undefined): readonly string[] =>
  (request?.content ?? []).map((block) => String(block["text"]));

/** 重置时注入的 seed 文本。 */
const seedText = (session: { appended: Appended[] }): string => {
  const blocks = session.appended[1]?.data["content"] as { text?: string }[] | undefined;
  return String(blocks?.[0]?.text ?? "");
};

describe("selectedPreset", () => {
  it("以日志里最后一条预设选择为准，而不是 live header", () => {
    const session: RotationSession = {
      id: "session-1",
      header: { agentPreset: "standard" },
      snapshotEvents: () => [
        { type: "agent-preset/selected", data: { agentPreset: "nano-flow" } },
        { type: "turn/start" },
      ],
    };
    expect(selectedPreset(session)).toBe("nano-flow");
  });

  it("没有事件时退回 header，两者都没有时 undefined", () => {
    expect(selectedPreset({ id: "a", header: { agentPreset: "nano-flow" } })).toBe("nano-flow");
    expect(selectedPreset({ id: "a" })).toBeUndefined();
  });
});

describe("lastAssistantText", () => {
  it("取最后一个已结束轮里最后一条含文本的 assistant 消息", () => {
    const session = makeSession({
      events: [
        ...turnEvents(1, [[{ type: "text", text: "第一轮结论" }]]),
        ...turnEvents(2, [
          [{ type: "reasoning", text: "内部推理" }],
          [{ type: "text", text: "第二轮中间文本" }],
          [{ type: "text", text: "第二轮最终答复" }],
        ]),
      ],
    });
    expect(lastAssistantText(session)).toBe("第二轮最终答复");
  });

  it("没有已结束轮或没有文本时为 undefined", () => {
    expect(lastAssistantText(makeSession())).toBeUndefined();
    const pendingOnly = makeSession({
      events: [{ type: "turn/start", seq: 1, data: { turn: 1 } }],
    });
    expect(lastAssistantText(pendingOnly)).toBeUndefined();
  });

  it("超长输出保尾并标注截断字节数", () => {
    const long = "甲".repeat(5000);
    const clipped = lastAssistantText(
      makeSession({ events: turnEvents(1, [[{ type: "text", text: long }]]) }),
    );
    expect(clipped).toBeDefined();
    expect(String(clipped).startsWith("…（前 ")).toBe(true);
    expect(String(clipped).endsWith("甲")).toBe(true);
    expect(String(clipped)).not.toContain("\uFFFD");
  });
});

describe("truncateTail", () => {
  it("未超过上限时原样返回", () => {
    expect(truncateTail("短文本", 100)).toBe("短文本");
  });

  it("超过上限时保留尾部", () => {
    const out = truncateTail("abcdef", 3);
    expect(out.endsWith("def")).toBe(true);
    expect(out).toContain("已截断");
  });

  it("多字节切口不残留替换字符", () => {
    const out = truncateTail("甲".repeat(4000), 1000);
    expect(out).not.toContain("\uFFFD");
    expect(out).toContain("已截断");
  });
});

describe("in-place reset", () => {
  it("below the threshold: keeps the session history untouched", async () => {
    const harness = makeHarness();
    await harness.send();
    expect(harness.session.appended).toHaveLength(0);
    expect(harness.originalPrompt.mock.calls[0]?.[0].sessionId).toBe("session-1");
  });

  it("at the threshold: shadows the surface and injects the seed, same session id", async () => {
    const harness = makeHarness();
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.session.appended.map((item) => item.type)).toEqual([
      "compaction/prune",
      "user/message",
    ]);
    const [prune, seed] = harness.session.appended;
    // nodes[0] 是系统提示（seq 1），只能从第二个节点开始遮蔽。
    expect(prune?.data["shadowedRange"]).toEqual({ start: 3, end: 5 });
    expect(prune?.data["shadowedSeqs"]).toEqual([3, 5]);
    // 两个被遮蔽节点按固定启发式价计（40 × 2），不是路由价（100 × 2）。
    expect(prune?.data["shadowedTokenCount"]).toBe(80);
    expect(seed?.opts).toMatchObject({
      surfaceOp: { op: "replace", startSeq: 3, endSeq: 5 },
      sourceEventSeqs: [3, 5],
    });
    expect(harness.flush).toHaveBeenCalledTimes(1);
    const sent = harness.originalPrompt.mock.calls[0]?.[0];
    expect(sent?.sessionId).toBe("session-1");
    // 用户原文原样发出，不再包 <rotation-prior-input>。
    expect(textsOf(sent)).toEqual(["用户消息"]);
    expect(String((seed?.data["content"] as { text?: string }[] | undefined)?.[0]?.text)).toContain(
      "报告进度与可推进队列",
    );
  });

  it("keeps the last turn's output block inside the seed", async () => {
    const session = makeSession({
      events: turnEvents(1, [[{ type: "text", text: "上一轮结论" }]]),
    });
    const harness = makeHarness({ session });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    const seed = seedText(harness.session);
    expect(seed).toContain(`<${LAST_OUTPUT_TAG}>`);
    expect(seed).toContain("上一轮结论");
    expect(seed.trimEnd().endsWith(`</${LAST_OUTPUT_TAG}>`)).toBe(true);
  });

  it("resets only once per produced assistant message", async () => {
    const harness = makeHarness();
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    await harness.send();
    expect(harness.session.appended).toHaveLength(2);
    // 新产出 assistant 消息后才允许下一次重置。
    harness.session.log.push({ type: "assistant/message", seq: 200, data: {} });
    await harness.send();
    expect(harness.session.appended).toHaveLength(4);
  });

  it("skips subagent sessions, other presets, steer prompts and unknown sessions", async () => {
    const subagent = makeSession({ header: { origin: "subagent" } });
    const sub = makeHarness({ session: subagent });
    sub.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await sub.send();
    const other = makeHarness();
    other.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await other.send({ sessionId: "session-other" });
    const regular = makeHarness();
    regular.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await regular.send({ mode: "steer" });
    await regular.send({ sessionId: "session-unknown" });
    expect(sub.session.appended).toHaveLength(0);
    expect(other.session.appended).toHaveLength(0);
    expect(regular.session.appended).toHaveLength(0);
    expect(regular.originalPrompt).toHaveBeenCalledTimes(2);
  });

  it("waits for the running turn to end", async () => {
    const session = makeSession({ events: [{ type: "turn/start", seq: 1, data: { turn: 1 } }] });
    const harness = makeHarness({ session });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.session.appended).toHaveLength(0);
  });

  it("leaves a surface with only the system prompt alone", async () => {
    const session = makeSession({ surfaceNodes: [7] });
    const harness = makeHarness({ session });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.session.appended).toHaveLength(0);
    expect(harness.originalPrompt).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain prompt when the session rejects the append", async () => {
    const session = makeSession({ failAppend: true });
    const harness = makeHarness({ session });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.warn).toHaveBeenCalled();
    expect(textsOf(harness.originalPrompt.mock.calls[0]?.[0])).toEqual(["用户消息"]);
  });

  it("restores the original prompt on dispose", () => {
    const harness = makeHarness();
    const wrapped = harness.controller.prompt;
    harness.dispose();
    expect(harness.controller.prompt).toBe(harness.originalPrompt);
    expect(harness.controller.prompt).not.toBe(wrapped);
  });
});

describe("reset seed", () => {
  const summary = "重置前自动执行 `nano_flow_check`：领域文档校验通过，索引已刷新。";

  it("runs the check for this session and appends the result before the output block", async () => {
    const autoCheck = vi.fn(async () => ({ text: summary }));
    const session = makeSession({
      events: turnEvents(1, [[{ type: "text", text: "上一轮结论" }]]),
    });
    const harness = makeHarness({ session, autoCheck });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(autoCheck).toHaveBeenCalledWith({ sessionId: "session-1", workspace: "C:\\work" });
    const seed = seedText(harness.session);
    expect(seed.indexOf(summary)).toBeLessThan(seed.indexOf(`<${LAST_OUTPUT_TAG}>`));
    expect(seed).toContain("报告进度与可推进队列");
  });

  it("names the bound plan and says no bind call is needed", async () => {
    const boundPlan = vi.fn(async () => "dsh/active/2026-11-16-示例");
    const harness = makeHarness({ boundPlan });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(boundPlan).toHaveBeenCalledWith({ sessionId: "session-1", workspace: "C:\\work" });
    const seed = seedText(harness.session);
    expect(seed).toContain("恢复当前 Plan：dsh/active/2026-11-16-示例");
    expect(seed).toContain("绑定未变");
  });

  it("keeps resetting when the check throws, and notes the failure", async () => {
    const autoCheck = vi.fn(async () => {
      throw new Error("node 挂了");
    });
    const harness = makeHarness({ autoCheck });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    const seed = seedText(harness.session);
    expect(seed).toContain("nano_flow_check");
    expect(seed).toContain("node 挂了");
    expect(harness.warn).toHaveBeenCalled();
  });
});
