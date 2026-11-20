import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_NANO_FLOW_SETTINGS } from "../../contract.js";
import { clearCompactionBridge, setCompactionBridge } from "../assembly/compaction-bridge.js";
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

afterEach(() => {
  // 桥是模块级槽：每个用例自己登记，跑完清空，免得串味。
  clearCompactionBridge();
});

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
    /** 预设里是否登记了压缩桥。 */
    bridge?: boolean;
    seam?: boolean;
    /** 注入第几轮时 throw：0 = 压缩前，1 = 压缩后。 */
    failInjectAt?: number;
    /** 第几次等待直接 reject（超时）：0 = 压缩前，1 = 压缩后。 */
    timeoutAt?: number;
    /** compactNow 抛出的错误。 */
    compactError?: unknown;
    /** 注入第几轮时挂住不结束：0 = 压缩前，1 = 压缩后；由 release() 放行。 */
    holdInjectAt?: number;
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
  /** 挂在半路的那次注入的放行开关；配合 {@link holdInjectAt} 使用。 */
  let release: (() => void) | undefined;
  const warn = vi.fn();
  const engine = {
    compactNow: vi.fn(async (_agent: unknown, _signal: AbortSignal) => {
      steps.push("compact");
      if (options.compactError !== undefined) throw options.compactError;
      return null;
    }),
  };
  // 桥＝预设内 `compactBridgeOnly` 那一行：把该 realm 的引擎封成 (agent, signal) 的函数。
  if (options.bridge !== false) {
    setCompactionBridge((agent, inner) => engine.compactNow(agent, inner));
  }
  const agent = { id: session.id };
  const originalPrompt = vi.fn(async (request: PromptRequestLike, _signal?: AbortSignal) => {
    const text = String((request.content[0] as { text?: string } | undefined)?.text ?? "");
    if (request.requestId === "request-1") {
      steps.push("user");
      return { accepted: true };
    }
    const stage = text === PRE_COMPACT_PROMPT ? "pre" : "post";
    steps.push(`inject:${stage}`);
    const index = injected;
    if (options.failInjectAt === index) {
      injected += 1;
      throw new Error(`${stage} turn rejected`);
    }
    injected += 1;
    // 模拟宿主：这一轮真的跑起来并结束。
    const finish = (): void => {
      for (const event of turnEvents(seq, index + 1)) session.log.push({ ...event });
      seq += 3;
      const waiter = pending.shift();
      waiter?.resolve();
      if (waiter !== undefined) steps.push(`waited:${stage}`);
    };
    if (options.holdInjectAt === index) {
      // 这一轮挂在半路，测试可以趁它没跑完去拆调用方的连接。
      return new Promise<{ accepted: boolean }>((resolve) => {
        release = () => {
          finish();
          resolve({ accepted: true });
        };
      });
    }
    finish();
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
  const send = (
    overrides: Partial<PromptRequestLike> = {},
    caller: AbortSignal = signal,
  ): Promise<{ accepted: boolean }> => controller.prompt(request(overrides), caller);
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
    /** 放行挂住的那次注入（没挂住时是空操作）。 */
    release: () => release?.(),
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
    // compactNow 拿到该会话的 agent 与一个未被取消的信号。
    expect(harness.engine.compactNow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
      expect.any(AbortSignal),
    );
    // 这个夹具没有任何轮次，所以不带轮号下限。
    expect(harness.waitForTurnEnd.mock.calls[0]?.[0]).not.toHaveProperty("afterTurn");
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("调用方中途断连时仍走完压缩并放行用户消息", async () => {
    const harness = makeHarness({ holdInjectAt: 0 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    const caller = new AbortController();
    const sent = harness.send({}, caller.signal);
    // 检查点那一轮还没跑完，浏览器先把这条 RPC 拆了。
    caller.abort();
    harness.release();
    await sent;
    // 1) 压缩照旧执行，拿到的不是调用方那个已 abort 的信号。
    expect(harness.engine.compactNow).toHaveBeenCalledTimes(1);
    expect(harness.engine.compactNow.mock.calls[0]?.[1]?.aborted).toBe(false);
    // 2) 恢复轮照样注入，两次等待的信号都没 abort。
    expect(harness.originalPrompt.mock.calls.map((call) => textsOf(call[0]))).toContainEqual([
      POST_COMPACT_PROMPT,
    ]);
    expect(harness.waitForTurnEnd.mock.calls.map((call) => call[0].signal.aborted)).toEqual([
      false,
      false,
    ]);
    // 3) 用户原消息被放行，且带着未 abort 的信号。
    const userCall = harness.originalPrompt.mock.calls.find((call) =>
      textsOf(call[0]).includes("用户消息"),
    );
    expect(userCall?.[1]).toBeDefined();
    expect(userCall?.[1]?.aborted).toBe(false);
    expect(harness.steps).toEqual(FULL_FLOW);
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

  it("压缩前那一轮没跑完时跳过压缩，仍放行用户消息", async () => {
    const harness = makeHarness({ failInjectAt: 0 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["inject:pre", "inject:post", "waited:post", "user"]);
    expect(harness.warn).toHaveBeenCalled();
    // 轮次还在跑，压缩只会拿到 busy；不制造这一次假失败。
    expect(harness.engine.compactNow).not.toHaveBeenCalled();
  });

  it("压缩后那一轮失败时只 warn，仍放行用户消息", async () => {
    const harness = makeHarness({ failInjectAt: 1 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["inject:pre", "waited:pre", "compact", "inject:post", "user"]);
    expect(harness.warn).toHaveBeenCalled();
  });

  it("等待超时时只 warn，跳过压缩继续往下", async () => {
    const harness = makeHarness({ timeoutAt: 0 });
    harness.setPressure({ projectedTokens: 700, contextWindow: 1000 });
    await harness.send();
    expect(harness.steps).toEqual(["inject:pre", "inject:post", "waited:post", "user"]);
    expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("pre-compact"));
    expect(harness.engine.compactNow).not.toHaveBeenCalled();
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

  it("预设没登记压缩桥时原样放行，并留一条 warn", async () => {
    const harness = await run({ bridge: false });
    expectPassthrough(harness);
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("exposes no compaction bridge"),
    );
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
