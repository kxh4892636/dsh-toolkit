import { randomUUID } from "node:crypto";

import type { NanoFlowSettings } from "../../contract.js";
import { describeError } from "../../shared/errors.js";
import { getCompactionBridge, type CompactionBridge } from "../assembly/compaction-bridge.js";
import type { HostServices } from "./services.js";

/** 会话的最小形状：id、header 与日志快照。 */
export interface RotationSession {
  readonly id: string;
  readonly header?: {
    readonly cwd?: string;
    readonly origin?: string;
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
  /** 会话日志快照；读最后一条预设选择与轮次边界（live header 的 `agentPreset` 不可靠）。 */
  snapshotEvents?(): readonly {
    readonly type: string;
    readonly seq?: number;
    readonly data?: unknown;
  }[];
}

/** tokenMeter 的上下文压力读数。 */
interface TokenMeterLike {
  contextPressure(session: RotationSession): {
    readonly pressureTokens?: number;
    /** 下一次请求的预计 prompt；与界面占用率同口径。 */
    readonly projectedTokens?: number;
    readonly contextWindow?: number;
  };
}

/** 一次用户 prompt 里本插件需要保留的字段。 */
interface PromptContentLike {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface PromptRequestLike {
  readonly requestId: string;
  readonly sessionId: string;
  readonly mode: "queue" | "steer";
  readonly content: readonly PromptContentLike[];
  readonly [key: string]: unknown;
}

/** 会话控制器的提示注入。 */
interface SessionControllerLike {
  prompt(request: PromptRequestLike, signal: AbortSignal): Promise<{ accepted: boolean }>;
}

/** `agents` 注册表：只取存活 agent（agent 与 session 同 id）。 */
interface AgentsLike {
  get(id: string): unknown;
}

/**
 * 等某会话的下一个 `turn/end`。
 *
 * 注入走的是包装前的真实 `prompt`，它准入即返回（只入 inbox），因此「那一轮跑完」
 * 只能由会话事件判定；宿主没有提供「某条消息跑完」的 promise。
 */
export type WaitForTurnEnd = (params: {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  /** 只认轮号大于它的 `turn/end`；用来区分「注入后开的那一轮」与更早的轮次。 */
  readonly afterTurn?: number;
  /** 等待预算；超时以 reject 表达，由调用方按失败处理。 */
  readonly timeoutMs: number;
}) => Promise<void>;

/** 轮转所需依赖。 */
interface RotationOptions {
  readonly services: HostServices;
  readonly config: { readonly presetId?: string };
  readonly settings: () => NanoFlowSettings;
  /** 会话 id → 存活会话；取不到时轮转不介入（宿主没有会话存储）。 */
  readonly sessionOf?: (id: string) => RotationSession | undefined;
  /** 会话是否运行本预设；缺省用 {@link selectedPreset} 读日志。 */
  readonly isNanoFlow?: (session: RotationSession) => boolean;
  /**
   * 等注入的那一轮结束；缺省时轮转不介入（原样放行），与「缺 tokenMeter 就放行」同风格。
   *
   * 装配在宿主半：`src/index.ts` 用 `session/event` 里该会话的 `turn/end` 实现。
   */
  readonly waitForTurnEnd?: WaitForTurnEnd;
}

/** 轮转前注入的那一轮：先把检查点写回磁盘，压缩后上下文里才还留着进度。 */
export const PRE_COMPACT_PROMPT =
  "（轮转前检查点）更新当前 Plan 的 `spec.md` 与 note：进度、证据、下一步，然后结束这一轮。";

/** 轮转后注入的那一轮：从磁盘重建状态，再跑一次文档校验。 */
export const POST_COMPACT_PROMPT =
  "（轮转后恢复）读取 `spec.md` 与 `notes_index.md`，然后执行 `nano_flow_check`。";

/** 等注入那一轮跑完的预算：超时只 warn，继续下一段，不阻断用户消息。 */
export const TURN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 会话里出现过的最大轮号。
 * @param events - 会话日志快照。
 * @returns 最大轮号；还没有任何轮次时为 undefined。
 */
export const lastTurnOf = (
  events: readonly { readonly type: string; readonly data?: unknown }[],
): number | undefined => {
  let last: number | undefined;
  for (const event of events) {
    if (event.type !== "turn/start" && event.type !== "turn/end") continue;
    const data = event.data;
    const turn =
      typeof data === "object" && data !== null ? (data as { turn?: unknown }).turn : undefined;
    if (typeof turn === "number" && (last === undefined || turn > last)) last = turn;
  }
  return last;
};

/**
 * 会话当前运行的预设：以日志里最后一条 `agent-preset/selected` 为准。
 *
 * 存活会话 header 的 `agentPreset` 在恢复会话时并不可靠（回到默认值），
 * 因此优先扫事件，扫不到才退回 header。
 * @param session - 目标会话。
 * @returns 预设 id；两个来源都没有时 undefined。
 */
export const selectedPreset = (session: RotationSession): string | undefined => {
  let events: readonly { readonly type: string; readonly data?: unknown }[] = [];
  try {
    events = session.snapshotEvents?.() ?? [];
  } catch {
    events = [];
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "agent-preset/selected") continue;
    const preset = (event.data as { agentPreset?: unknown } | undefined)?.agentPreset;
    if (typeof preset === "string" && preset !== "") return preset;
  }
  return session.header?.agentPreset;
};

const service = <T>(services: HostServices, name: string): T | undefined => {
  try {
    const value = services.get(name);
    return typeof value === "object" && value !== null ? (value as T) : undefined;
  } catch {
    // 读数失败（宿主不暴露该服务）时按缺失处理，轮转不介入。
    return undefined;
  }
};

/** 会话日志快照；读不到时按空处理。 */
const eventsOf = (
  session: RotationSession,
): readonly { readonly type: string; readonly seq?: number; readonly data?: unknown }[] => {
  try {
    return session.snapshotEvents?.() ?? [];
  } catch {
    return [];
  }
};

/** 最后一轮是否已结束：没有未闭合的 `turn/start`。 */
const turnClosed = (events: readonly { readonly type: string }[]): boolean => {
  let open = false;
  for (const event of events) {
    if (event.type === "turn/start") open = true;
    else if (event.type === "turn/end") open = false;
  }
  return !open;
};

/** 日志里的最大 seq；读不到任何带 seq 的事件时 undefined。 */
const maxSeq = (events: readonly { readonly seq?: number }[]): number | undefined => {
  let max: number | undefined;
  for (const event of events) {
    if (typeof event.seq !== "number") continue;
    if (max === undefined || event.seq > max) max = event.seq;
  }
  return max;
};

/** 锚点之后是否已经产出过 assistant 消息（防止一次轮转反复触发）。 */
const advancedSince = (
  events: readonly { readonly type: string; readonly seq?: number }[],
  from: number,
): boolean =>
  events.some(
    (event) =>
      typeof event.seq === "number" && event.seq > from && event.type === "assistant/message",
  );

/** 轮转引擎：只挂压力触发的 prompt 包装（轮转只能自动触发）。 */
interface RotationEngine {
  /** 挂上压力触发的 prompt 包装；返回 disposer。 */
  attach(): () => void;
}

/** 一次轮转的目标：agent 与从预设 realm 登记过来的压缩桥。 */
interface RotationTarget {
  readonly agent: unknown;
  readonly bridge: CompactionBridge;
}

/**
 * 创建轮转引擎：`queue` 消息到达且上下文压力达阈值时，串行跑四步，先把用户消息扣住。
 *
 * 1. 注入一轮「把进度写回 spec 与 note」，等它结束；
 * 2. 预设 realm 里登记过来的压缩桥（`compaction.compactNow(agent, signal)`）摘要旧历史；
 * 3. 注入一轮「读回 spec 与 notes_index，再跑 nano_flow_check」，等它结束；
 * 4. 放行用户原来那条消息。
 *
 * 第 1、3 步抛错或超时、第 2 步抛 `ManualCompactionError`（如 `busy`）都只 warn，
 * 不阻断第 4 步：任何失败都不许把用户消息弄丢。
 * 挂在宿主层（根插件）而不是预设行：预设行看不到 `ctx.agent`（cordis 的 inject 守卫），
 * 由会话日志里最后一条 `agent-preset/selected` 判定预设。
 * @param options - 宿主能力、设置、会话解析与「等一轮结束」的 seam。
 * @returns 只挂压力包装的引擎；缺 sessionController / tokenMeter / seam 时 attach 为空操作。
 */
export const createRotation = (options: RotationOptions): RotationEngine => {
  const { services, config, settings } = options;
  const meter = service<TokenMeterLike>(services, "tokenMeter");
  const controller = service<SessionControllerLike>(services, "sessionController");
  const presetId = config.presetId ?? "nano-flow";
  const sessionOf = options.sessionOf ?? ((): undefined => undefined);
  const waitForTurnEnd = options.waitForTurnEnd;
  const isNanoFlow = (session: RotationSession): boolean =>
    options.isNanoFlow?.(session) ?? selectedPreset(session) === presetId;
  /** 同一会话的并发轮转只执行一次。 */
  const rotating = new Set<string>();
  /** 上一次轮转完成时的最大 seq；要有新的 assistant 输出才允许再轮转。 */
  const rotatedAt = new Map<string, number>();

  /**
   * agent 与压缩桥；缺 agents 服务、缺 agent 或没登记桥时 undefined。
   *
   * 引擎不能从 `agent.ctx.get('compaction')` 取：它在预设的 isolate realm 里，
   * 根作用域看不到。引擎由预设内 `compactBridgeOnly` 那一行登记进模块级桥。
   */
  const targetOf = (sessionId: string): RotationTarget | undefined => {
    const agents = service<AgentsLike>(services, "agents");
    const agent = agents?.get(sessionId);
    if (agent === undefined || agent === null) return undefined;
    const bridge = getCompactionBridge();
    if (bridge === undefined) return undefined;
    return { agent, bridge };
  };

  const original =
    controller !== undefined && typeof controller.prompt === "function"
      ? controller.prompt.bind(controller)
      : undefined;
  const target =
    controller === undefined
      ? undefined
      : (controller as unknown as { prompt: SessionControllerLike["prompt"] });

  /**
   * 注入一轮并把这一轮等完；失败只 warn。
   *
   * 等待先挂上再注入，否则那一轮的 `turn/end` 可能在订阅建立前就发过。
   * @param sessionId - 目标会话（与 agent 同 id）。
   * @param request - 用户那条 prompt，用来继承 sessionId 与其余字段。
   * @param signal - 调用方取消信号。
   * @param text - 注入的正文。
   * @param stage - 日志里区分「压缩前 / 压缩后」。
   */
  const runInjectedTurn = async (
    session: RotationSession,
    request: PromptRequestLike,
    signal: AbortSignal,
    text: string,
    stage: string,
  ): Promise<boolean> => {
    if (waitForTurnEnd === undefined || original === undefined) return false;
    const gate = new AbortController();
    const waiting = {
      sessionId: session.id,
      signal: AbortSignal.any([signal, gate.signal]),
      timeoutMs: TURN_WAIT_TIMEOUT_MS,
    };
    const afterTurn = lastTurnOf(eventsOf(session));
    const settled =
      afterTurn === undefined ? waitForTurnEnd(waiting) : waitForTurnEnd({ ...waiting, afterTurn });
    // 注入自己抛错时这个等待没人 await，先挂一个 catch 兜住未处理的 rejection。
    settled.catch(() => {});
    try {
      const injected: PromptRequestLike = {
        ...request,
        requestId: randomUUID(),
        content: [{ type: "text", text }],
      };
      const accepted = await original(injected, signal);
      if (accepted.accepted === false) {
        gate.abort();
        services.logger.warn(`nano-flow: rotation ${stage} turn was not accepted`);
        return false;
      }
      await settled;
      return true;
    } catch (error) {
      gate.abort();
      services.logger.warn(`nano-flow: rotation ${stage} turn failed: ${describeError(error)}`);
      return false;
    }
  };

  /**
   * 让预设 realm 里的压缩引擎摘要旧历史；失败（含 `busy`）只 warn。
   *
   * 引擎的手动路径要求 agent 处于 idle 且没有开着的 turn，否则抛
   * `ManualCompactionError('busy')`；内部自己 `sessions.flush`，写
   * `compaction/start|summary|end` 与一条替换用户消息。
   */
  const compactNow = async (rotation: RotationTarget, signal: AbortSignal): Promise<void> => {
    try {
      await rotation.bridge(rotation.agent, signal);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const suffix = typeof code === "string" && code !== "" ? ` (${code})` : "";
      services.logger.warn(
        `nano-flow: rotation compaction failed${suffix}: ${describeError(error)}`,
      );
    }
  };

  const redirect = async (
    session: RotationSession,
    request: PromptRequestLike,
    signal: AbortSignal,
  ): Promise<{ accepted: boolean }> => {
    const fallback = (): Promise<{ accepted: boolean }> => original!(request, signal);
    if (meter === undefined || original === undefined || waitForTurnEnd === undefined) {
      return fallback();
    }
    const pressure = meter.contextPressure(session);
    const used = pressure.projectedTokens ?? pressure.pressureTokens;
    const window = pressure.contextWindow;
    if (used === undefined || window === undefined || window <= 0) return fallback();
    if (used < window * settings().rotateAt) return fallback();
    if (rotating.has(session.id)) return fallback();
    const rotation = targetOf(session.id);
    if (rotation === undefined) {
      // 过阈值却没有压缩桥（预设没挂、或那一行没登记上）：静默不轮转会让上下文一路涨，留一条痕。
      services.logger.warn(
        `nano-flow: rotation skipped for "${session.id}": this preset exposes no compaction bridge`,
      );
      return fallback();
    }
    // 正在跑的回合不能压缩：idle 引擎与「当前那一步之后要用的历史」都要求轮次边界。
    const events = eventsOf(session);
    if (!turnClosed(events)) return fallback();
    const rotated = rotatedAt.get(session.id);
    if (rotated !== undefined && !advancedSince(events, rotated)) return fallback();

    rotating.add(session.id);
    try {
      // 前一步没跑完（超时/注入被拒）时轮次还在，压缩必然 busy：直接跳过，别制造一次假失败。
      if (await runInjectedTurn(session, request, signal, PRE_COMPACT_PROMPT, "pre-compact")) {
        await compactNow(rotation, signal);
      }
      await runInjectedTurn(session, request, signal, POST_COMPACT_PROMPT, "post-compact");
    } finally {
      rotating.delete(session.id);
      const anchor = maxSeq(eventsOf(session));
      if (anchor !== undefined) rotatedAt.set(session.id, anchor);
    }
    // 四步里的三段都已各自 warn 过；用户这条消息一定放行。
    return fallback();
  };

  return {
    attach(): () => void {
      if (original === undefined || target === undefined) return () => {};
      const previous = target.prompt;
      const wrapped: SessionControllerLike["prompt"] = async (request, signal) => {
        if (request.mode !== "queue") return original(request, signal);
        const session = sessionOf(request.sessionId);
        if (session === undefined) return original(request, signal);
        const header = session.header ?? {};
        if (header.origin === "subagent" || (header.delegationDepth ?? 0) > 0) {
          return original(request, signal);
        }
        if (!isNanoFlow(session)) return original(request, signal);
        return redirect(session, request, signal);
      };
      target.prompt = wrapped;
      return () => {
        if (target.prompt === wrapped) target.prompt = previous;
      };
    },
  };
};
