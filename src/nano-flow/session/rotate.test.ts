import { describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_NANO_FLOW_SETTINGS } from "../../contract.js";
import {
  createRotation,
  POST_COMPACT_PROMPT,
  PRE_COMPACT_PROMPT,
  selectedPreset,
  type PromptRequestLike,
  type RotationSession,
} from "./rotate.js";
import type { HostServices } from "./services.js";

type Pressure = {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
};

type EventLike = { type: string; seq?: number; data?: unknown };

const signal = new AbortController().signal;

/** 一轮事件：turn/start + 一条 assistant 消息 + turn/end。 */
const turnEvents = (from: number, turn: number): readonly EventLike[] => [
  { type: "turn/start", seq: from, data: { turn } },
  { type: "assistant/message", seq: from + 1, data: { turn } },
  { type: "turn/end", seq: from + 2, data: { turn, reason: { kind: "completed" } } },
];

/** 可写会话：日志只追加，snapshot 直接读它。 */
const makeSession = (
  options: {
    id?: string;
    preset?: string;
    header?: RotationSession["header"];
    events?: readonly EventLike[];
  } = {},
): RotationSession & { log: EventLike[] } => {
  const log: EventLike[] = [
    { type: "agent-preset/selected", seq: 0, data: { agentPreset: options.preset ?? "nano-flow" } },
    ...(options.events ?? []),
  ];
  return {
    id: options.id ?? "session-1",
    header: { cwd: "/work", ...options.header },
    log,
    snapshotEvents: () => log,
  };
};

/** 一次等待：由注入的那一轮「跑完」来 resolve，取消时 reject 并出队。 */
type Pending = { resolve: () => void; reject: (error: unknown) => void };

const makeHarness = (
  options: {
    session?: ReturnType<typeof makeSession>;
    meter?: boolean;
    agents?: boolean;
    compaction?: boolean;
    seam?: boolean;
    /** 注入第几轮时 throw：0 = 压缩前，1 = 压缩后。 */
    failInjectAt?: number;
    /** 第几次等待直接 reject（超时）：0 = 压缩前，1 = 压缩后。 */
    timeoutAt?: number;
    /** compactNow 抛出的错误。 */
    compactError?: unknown;
  } = {},
) => {
  const session = options.session ?? makeSession();
  /** 四步的执行顺序，测试的主断言。 */
  const steps: string[] = [];
  let pressure: Pressure = { pressureTokens: 10, contextWindow: 1000 };
  let seq = 1000;
  let injected = 0;
  let waits = 0;
  const pending: Pending[] = [];
  const warn = vi.fn();
  const engine = {
    compactNow: vi.fn(async () => {
      steps.push("compact");
      if (options.compactError !== undefined) throw options.compactError;
      return null;
    }),
  };
  const agent = {
    id: session.id,
    ctx: {
      get: (name: string) =>
        name === "compaction" && options.compaction !== false ? engine : undefined,
    },
  };
  const originalPrompt = vi.fn(async (request: PromptRequestLike, _signal?: AbortSignal) => {
    const text = String((request.content[0] as { text?: string } | undefined)?.text ?? "");
    if (request.requestId === "request-1") {
      steps.push("user");
      return { accepted: true };
    }
    const stage = text === PRE_COMPACT_PROMPT ? "pre" : "post";
    steps.push(`inject:${stage}`);
    if (options.failInjectAt === injected) {
      injected += 1;
      throw new Error(`${stage} turn rejected`);
    }
    injected += 1;
    // 模拟宿主：这一轮真的跑起来并结束。
    for (const event of turnEvents(seq, injected)) session.log.push({ ...event });
    seq += 3;
    const waiter = pending.shift();
    waiter?.resolve();
    if (waiter !== undefined) steps.push(`waited:${stage}`);
    return { accepted: true };
  });
  const waitForTurnEnd = vi.fn(
    ({ signal: outer }: { sessionId: string; signal: AbortSignal; timeoutMs: number }) => {
      const index = waits;
      waits += 1;
      if (options.timeoutAt === index) return Promise.reject(new Error("wait timed out"));
      return new Promise<void>((resolve, reject) => {
        const entry: Pending = {
          resolve: () => {
            drop();
            resolve();
          },
          reject: (error: unknown) => {
            drop();
            reject(error);
          },
        };
        const drop = (): void => {
          const at = pending.indexOf(entry);
          if (at >= 0) pending.splice(at, 1);
        };
        pending.push(entry);
        outer.addEventListener("abort", () => entry.reject(new Error("aborted")), { once: true });
      });
    },
  );
  const services = {
    get: (name: string) => {
      if (name === "tokenMeter" && options.meter !== false) {
        return { contextPressure: () => pressure };
      }
      if (name === "sessionController") return controller;
      if (name === "agents" && options.agents !== false) {
        return { get: (id: string) => (id === session.id ? agent : undefined) };
      }
      return undefined;
    },
    logger: { warn },
  } as unknown as HostServices;
  const controller = { prompt: originalPrompt };
  const rotation = createRotation({
    services,
    config: { presetId: "nano-flow" },
    settings: () => ({ ...DEFAULT_NANO_FLOW_SETTINGS, rotateAt: 0.618 }),
    sessionOf: (id) => (id === session.id ? session : undefined),
    ...(options.seam === false ? {} : { waitForTurnEnd }),
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
    originalPrompt,
    session,
    steps,
    engine,
    warn,
    waitForTurnEnd,
    dispose,
    send,
    setPressure: (next: Pressure) => (pressure = next),
  };
};

const textsOf = (request: PromptRequestLike | undefined): readonly string[] =>
  (request?.content ?? []).map((block) => String(block["text"]));

/** 一次完整轮转的四步顺序。 */
const FULL_FLOW = ["inject:pre", "waited:pre", "compact", "inject:post", "waited:post", "user"];

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

describe("two fixed prompts", () => {
  it("压缩前写回检查点，压缩后读回并校验", () => {
    expect(PRE_COMPACT_PROMPT).toContain("spec.md");
    expect(PRE_COMPACT_PROMPT).toContain("note");
    expect(PRE_COMPACT_PROMPT).toContain("下一步");
    expect(POST_COMPACT_PROMPT).toContain("spec.md");
    expect(POST_COMPACT_PROMPT).toContain("notes_index.md");
    expect(POST_COMPACT_PROMPT).toContain("nano_flow_check");
  });
});

describe("rotation flow", () => {
  it("触发时串行四步，用户消息最后才放行", async () => {
    const harness = makeHarness();
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(FULL_FLOW);
    // 两次注入都换新 requestId，继承原会话，不改用户那条消息。
    const calls = harness.originalPrompt.mock.calls;
    const injectedRequests = [calls[0]?.[0], calls[1]?.[0]];
    expect(injectedRequests.map(textsOf)).toEqual([[PRE_COMPACT_PROMPT], [POST_COMPACT_PROMPT]]);
    expect(injectedRequests.map((req) => req?.requestId)).not.toContain("request-1");
    expect(injectedRequests.map((req) => req?.sessionId)).toEqual(["session-1", "session-1"]);
    // 用户消息原样发出，没有被改写。
    expect(textsOf(calls[2]?.[0])).toEqual(["用户消息"]);
    // compactNow 拿到该会话的 agent 与这一次请求的信号。
    expect(harness.engine.compactNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      signal,
    );
    // 这个夹具没有任何轮次，所以不带轮号下限。
    expect(harness.waitForTurnEnd.mock.calls[0]?.[0]).not.toHaveProperty("afterTurn");
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("等待带上的轮号下限是注入前的最大轮号", async () => {
    const session = makeSession({
      events: [
        { type: "turn/start", seq: 1, data: { turn: 1 } },
        { type: "turn/end", seq: 2, data: { turn: 1 } },
        { type: "turn/start", seq: 3, data: { turn: 2 } },
        { type: "turn/end", seq: 4, data: { turn: 2 } },
      ],
    });
    const harness = makeHarness({ session });
    harness.setPressure({ projectedTokens: 900, contextWindow: 1000 });
    await harness.send();
    expect(harness.waitForTurnEnd.mock.calls[0]?.[0]).toMatchObject({ afterTurn: 2 });
  });

  it("压缩前那一轮失败时只 warn，仍压缩并放行", async () => {
    const harness = makeHarness({ failInjectAt: 0 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["inject:pre", "compact", "inject:post", "waited:post", "user"]);
    expect(harness.warn).toHaveBeenCalled();
    expect(harness.engine.compactNow).toHaveBeenCalledTimes(1);
  });

  it("压缩后那一轮失败时只 warn，仍放行用户消息", async () => {
    const harness = makeHarness({ failInjectAt: 1 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["inject:pre", "waited:pre", "compact", "inject:post", "user"]);
    expect(harness.warn).toHaveBeenCalled();
  });

  it("等待超时时只 warn 并继续往下", async () => {
    const harness = makeHarness({ timeoutAt: 0 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["inject:pre", "compact", "inject:post", "waited:post", "user"]);
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("pre-compact"));
  });

  it("compactNow 报 busy 时只 warn 并放行", async () => {
    const busy = Object.assign(new Error("manual compaction requires an idle agent"), {
      name: "ManualCompactionError",
      code: "busy",
    });
    const harness = makeHarness({ compactError: busy });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(FULL_FLOW);
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("busy"));
    expect(textsOf(harness.originalPrompt.mock.calls[2]?.[0])).toEqual(["用户消息"]);
  });
});

describe("fallbacks", () => {
  const run = async (options: Parameters<typeof makeHarness>[0]) => {
    const harness = makeHarness(options);
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    return harness;
  };

  const expectPassthrough = (harness: Awaited<ReturnType<typeof run>>) => {
    expect(harness.steps).toEqual(["user"]);
    expect(harness.engine.compactNow).not.toHaveBeenCalled();
    expect(textsOf(harness.originalPrompt.mock.calls[0]?.[0])).toEqual(["用户消息"]);
  };

  it("缺等待 seam 时原样放行", async () => {
    expectPassthrough(await run({ seam: false }));
  });

  it("缺 agents 服务时原样放行", async () => {
    expectPassthrough(await run({ agents: false }));
  });

  it("预设没挂 compaction 引擎时原样放行", async () => {
    expectPassthrough(await run({ compaction: false }));
  });

  it("缺 tokenMeter 时原样放行", async () => {
    expectPassthrough(await run({ meter: false }));
  });

  it("不到阈值时不介入", async () => {
    const harness = makeHarness();
    await harness.send();
    expect(harness.steps).toEqual(["user"]);
    expect(harness.waitForTurnEnd).not.toHaveBeenCalled();
  });

  it("上一轮未结束时不动", async () => {
    const session = makeSession({ events: [{ type: "turn/start", seq: 1, data: { turn: 1 } }] });
    const harness = makeHarness({ session });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["user"]);
    expect(harness.engine.compactNow).not.toHaveBeenCalled();
  });

  it("跳过子 agent、其他预设、steer 与未知会话", async () => {
    const sub = makeHarness({ session: makeSession({ header: { origin: "subagent" } }) });
    sub.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await sub.send();
    const other = makeHarness({ session: makeSession({ preset: "standard" }) });
    other.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await other.send();
    const steer = makeHarness();
    steer.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await steer.send({ mode: "steer" });
    await steer.send({ sessionId: "session-unknown" });
    expect(sub.steps).toEqual(["user"]);
    expect(other.steps).toEqual(["user"]);
    expect(steer.steps).toEqual(["user", "user"]);
  });

  it("同一会话的并发轮转只跑一次", async () => {
    const harness = makeHarness();
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await Promise.all([harness.send(), harness.send()]);
    expect(harness.steps.filter((step) => step === "compact")).toHaveLength(1);
  });

  it("轮转后要产出新的 assistant 输出才允许再轮转", async () => {
    const harness = makeHarness();
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    const afterFirst = harness.steps.length;
    await harness.send();
    expect(harness.steps.slice(afterFirst)).toEqual(["user"]);
    harness.session.log.push({ type: "assistant/message", seq: 5000, data: {} });
    await harness.send();
    expect(harness.steps.slice(afterFirst + 1)).toEqual(FULL_FLOW);
  });

  it("dispose 还原原始 prompt", () => {
    const harness = makeHarness();
    const wrapped = harness.controller.prompt;
    expect(wrapped).not.toBe(harness.originalPrompt);
    harness.dispose();
    expect(harness.controller.prompt).toBe(harness.originalPrompt);
  });
});
