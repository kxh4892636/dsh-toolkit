import { randomUUID } from "node:crypto";

import type { NanoFlowSettings } from "../../contract.js";
import {
  ASSISTANT_LIMIT,
  groupByTurn,
  textOf,
  type SessionEventLike,
} from "../planning/plan-log.js";
import { asRecord } from "../../shared/record.js";
import { activePlans, listPlans, planRefOf } from "../planning/plan.js";
import type { HostServices } from "./services.js";
import { describeError } from "../../shared/errors.js";

/** 会话的最小形状：id、header 与日志快照。 */
export interface RotationSession {
  readonly id: string;
  readonly header?: {
    readonly cwd?: string;
    readonly origin?: string;
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
  };
  /** 会话日志快照；读最后一条预设选择（live header 的 `agentPreset` 不可靠）与上一轮输出。 */
  snapshotEvents?(): readonly {
    readonly type: string;
    readonly seq?: number;
    readonly data?: unknown;
  }[];
}

/** 宿主 `Session` 上本模块要用的可写子集：读表面节点、追加事件。 */
export interface SurfaceSession extends RotationSession {
  readonly surface: { readonly nodes: readonly number[] };
  append(type: string, data: unknown, opts?: unknown): { readonly seq?: number };
}

/** tokenMeter 的上下文压力与节点计价。 */
interface TokenMeterLike {
  contextPressure(session: RotationSession): {
    readonly pressureTokens?: number;
    /** 下一次请求的预计 prompt；与界面占用率同口径。 */
    readonly projectedTokens?: number;
    readonly contextWindow?: number;
  };
  /**
   * 当前表面每个节点的计价；计遮蔽价用。
   *
   * `heuristicTokens` 是固定启发式价（与路由无关），遮蔽价协议要求用它：
   * 替换事件的 `shadowedTokenCount` 必须与追加时同一套估价口径一致，
   * 用路由价会让折叠出来的上下文面积对不上（`dsh-token-meter/src/types.ts:37-53`）。
   */
  measure?(session: RotationSession): {
    readonly nodes: readonly { readonly seq: number; readonly heuristicTokens: number }[];
  };
}

/** 会话存储的落盘屏障。 */
interface SessionsLike {
  flush?(session: unknown): Promise<unknown>;
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

/** 工作目录服务。 */
interface WorkingDirectoryLike {
  get(session: RotationSession): string;
}

/** 重置所需依赖。 */
interface RotationOptions {
  readonly services: HostServices;
  readonly config: { readonly presetId?: string; readonly workspace?: string };
  readonly domainRoot: string;
  readonly settings: () => NanoFlowSettings;
  /** 会话 id → 存活会话；取不到时重置不介入（宿主没有会话存储）。 */
  readonly sessionOf?: (id: string) => RotationSession | undefined;
  /** 会话是否运行本预设；缺省用 {@link selectedPreset} 读日志。 */
  readonly isNanoFlow?: (session: RotationSession) => boolean;
  /**
   * 重置前跑一次校验（等价于执行一次 `nano_flow_check`）。
   *
   * 结论写进 seed（在输出块之前）；抛错只记 warn，不阻断重置。
   */
  readonly autoCheck?: (params: {
    readonly sessionId: string;
    readonly workspace: string;
  }) => Promise<{ readonly text: string } | undefined>;
  /**
   * 本会话当前的 Plan 绑定（`<domain>/<lifecycle>/<name>`），写进 seed 的恢复行。
   *
   * 同一会话内绑定不变，因此只需要读；读不到时 seed 退回「先 bind」的要求。抛错只记 warn。
   */
  readonly boundPlan?: (params: {
    readonly sessionId: string;
    readonly workspace: string;
  }) => Promise<string | undefined>;
}

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
    // 读数失败（宿主不暴露该服务）时按缺失处理，重置直接不介入。
    return undefined;
  }
};

/** 上一轮模型输出在 seed 里的标签。 */
export const LAST_OUTPUT_TAG = "reset-last-output";

/** 单轮输出进入 seed 的字节上限：复用 log.jsonl 的 assistant 预算（这里保尾，log 保头）。 */
const LAST_OUTPUT_LIMIT = ASSISTANT_LIMIT;

/**
 * 保尾截断：超过上限时丢掉开头，保住结尾的结论。
 *
 * 按字节切会把一个 UTF-8 字符劈开，`toString("utf8")` 会在切口处留下 U+FFFD；
 * 这里剥掉开头全部替换字符，使标注的字节数与实际保留内容一致。
 * @param text - 原文。
 * @param limit - 字节上限。
 * @returns 截断后的文本（头部标注被截掉的字节数）。
 */
export const truncateTail = (text: string, limit: number): string => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= limit) return text;
  const tail = Buffer.from(text, "utf8")
    .subarray(bytes - limit)
    .toString("utf8")
    .replace(/^�+/u, "");
  const dropped = bytes - Buffer.byteLength(tail, "utf8");
  return `…（前 ${dropped} 字节已截断）\n${tail}`;
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

/**
 * 最后一个已结束轮的「最后一条含文本的 assistant 消息」。
 *
 * 轮次归属复用 plan-log 的 `groupByTurn`；只读会话快照，不写任何事件。
 * @param session - 被重置的会话。
 * @returns 截断到上限的文本；没有已结束轮或没有文本时 undefined。
 */
export const lastAssistantText = (session: RotationSession): string | undefined => {
  const events = eventsOf(session);
  if (events.length === 0) return undefined;
  const turns = groupByTurn(events as readonly SessionEventLike[]);
  let target: number | undefined;
  for (const [turn, list] of turns) {
    if (!list.some((event) => event.type === "turn/end")) continue;
    if (target === undefined || turn > target) target = turn;
  }
  if (target === undefined) return undefined;
  let text: string | undefined;
  for (const event of turns.get(target) ?? []) {
    if (event.type !== "assistant/message") continue;
    const message = asRecord(asRecord(event.data)["message"]);
    const joined = textOf(message["content"]);
    if (joined.trim() !== "") text = joined;
  }
  if (text === undefined) return undefined;
  return truncateTail(text.trim(), LAST_OUTPUT_LIMIT);
};

/** seed 的可选片段。 */
interface SeedParts {
  /** 上一轮 assistant 最终文本；没有已结束轮时省略。 */
  readonly lastOutput?: string;
  /** 重置后自动校验结论；没有 autoCheck 时省略。 */
  readonly checked?: string;
  /** 本会话绑定的 Plan（`<domain>/<lifecycle>/<name>`）。 */
  readonly planReference?: string;
}

const buildSeed = async (
  workspace: string,
  domainRoot: string,
  seed: SeedParts,
): Promise<string> => {
  let planReference = seed.planReference;
  if (planReference === undefined) {
    try {
      const plans = activePlans(await listPlans(workspace, domainRoot));
      const only = plans[0];
      if (plans.length === 1 && only !== undefined) planReference = planRefOf(only);
    } catch {
      // 读不到 Plan 时保留“先问用户”的提示。
    }
  }
  const parts = [
    "（本会话的上下文达到阈值，旧历史已被遮蔽；Plan 在磁盘上，状态不丢，会话仍是同一个。）",
  ];
  if (planReference !== undefined) {
    parts.push(
      seed.planReference === undefined
        ? `恢复当前 Plan：${planReference}`
        : `恢复当前 Plan：${planReference}（绑定未变，无需再调 nano_flow_bind）`,
    );
  } else {
    parts.push(
      "恢复当前 Plan：先按 `.agents/domains/CONTEXT-MAP.md` 定位本会话的业务域，工作区里有多个 active 的 Plan 时先问用户是哪个",
    );
  }
  parts.push(
    "读 spec.md 与 notes_index.md，先报告进度与可推进队列，再处理本条消息（它若已指明要做什么，直接做）。",
  );
  if (seed.checked !== undefined) parts.push(seed.checked);
  if (seed.lastOutput !== undefined) {
    parts.push(
      `以下 XML 块是重置前会话最后一轮的模型输出：\n<${LAST_OUTPUT_TAG}>\n${seed.lastOutput}\n</${LAST_OUTPUT_TAG}>`,
    );
  }
  return parts.join("\n\n");
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

/** 重置之后是否已经产出过新的 assistant 消息（防止同一占用反复重置）。 */
const advancedSince = (
  events: readonly { readonly type: string; readonly seq?: number }[],
  from: number,
): boolean =>
  events.some(
    (event) =>
      typeof event.seq === "number" && event.seq > from && event.type === "assistant/message",
  );

/** 轮转引擎：只挂压力触发的 prompt 包装（重置只能自动触发）。 */
interface RotationEngine {
  /** 挂上压力触发的 prompt 包装；返回 disposer。 */
  attach(): () => void;
}

/**
 * 创建轮转引擎：只在 `queue` 消息进入时检查上下文压力，达到阈值就地把本会话的历史遮蔽掉。
 *
 * 做法是把表面节点 `nodes[1..]` 整体替换成一条 seed 消息（`compaction/prune` 记遮蔽价，
 * 紧跟一条带 `surfaceOp.replace` 的 `user/message`）。日志只追加、不删除，会话 id 不变，
 * 因此同一会话上的子 agent、后台 job 与 Plan 绑定全部原样存活。
 * 挂在宿主层（根插件）而不是预设行：预设行看不到 `ctx.agent`（cordis 的 inject 守卫），
 * 由会话日志里最后一条 `agent-preset/selected` 判定预设。
 * @param options - 宿主能力、领域根、设置与会话解析。
 * @returns 只挂压力包装的引擎；宿主缺少 sessionController 或 sessions 时 attach 为空操作。
 */
export const createRotation = (options: RotationOptions): RotationEngine => {
  const { services, config, domainRoot, settings } = options;
  const meter = service<TokenMeterLike>(services, "tokenMeter");
  const controller = service<SessionControllerLike>(services, "sessionController");
  const sessions = service<SessionsLike>(services, "sessions");
  const workingDirectory = service<WorkingDirectoryLike>(services, "workingDirectory");
  const presetId = config.presetId ?? "nano-flow";
  const sessionOf = options.sessionOf ?? ((): undefined => undefined);
  const isNanoFlow = (session: RotationSession): boolean =>
    options.isNanoFlow?.(session) ?? selectedPreset(session) === presetId;
  /** 同一会话的并发重置只执行一次。 */
  const rotating = new Set<string>();
  /** 上一次重置注入的 seed 事件的 seq；用于「重置后要产出新 assistant 才允许再重置」。 */
  const resetSeqs = new Map<string, number>();

  /** 宿主 Session 形状检查：没有 surface/append 时不介入。 */
  const asSurfaceSession = (session: RotationSession): SurfaceSession | undefined => {
    const candidate = session as Partial<SurfaceSession>;
    if (typeof candidate.append !== "function") return undefined;
    if (!Array.isArray(candidate.surface?.nodes)) return undefined;
    return candidate as SurfaceSession;
  };

  /** 新会话建立后跑一次校验（等价于 `nano_flow_check`）；结论进 seed，失败只 warn。 */
  const runAutoCheck = async (
    sessionId: string,
    workspace: string,
  ): Promise<{ readonly text: string } | undefined> => {
    const check = options.autoCheck;
    if (check === undefined) return undefined;
    try {
      return await check({ sessionId, workspace });
    } catch (error) {
      services.logger.warn(`nano-flow: auto check before reset failed: ${describeError(error)}`);
      return {
        text: `重置前自动执行 \`nano_flow_check\` 失败：${describeError(error)}。先手工跑一次确认 Plan 状态。`,
      };
    }
  };

  /** 读本会话的 Plan 绑定；失败只 warn。 */
  const boundPlan = async (sessionId: string, workspace: string): Promise<string | undefined> => {
    const read = options.boundPlan;
    if (read === undefined) return undefined;
    try {
      return await read({ sessionId, workspace });
    } catch (error) {
      services.logger.warn(`nano-flow: read of the bound plan failed: ${describeError(error)}`);
      return undefined;
    }
  };

  /**
   * 就地遮蔽整段历史：保留 `nodes[0]`（系统提示，replace 覆盖它会抛），其余换成 seed。
   *
   * `compaction/prune` 必须紧邻 replace 且区间完全一致，否则 tokenMeter 折叠时抛错；
   * `shadowedTokenCount` 用固定启发式价（`heuristicTokens`）而不是路由价；
   * `sourceEventSeqs` 要覆盖每一个被遮蔽节点。
   * @returns 注入的 seed 事件的 seq；表面只有系统提示时不重置，返回 undefined。
   */
  const clearSurface = async (
    session: SurfaceSession,
    seed: string,
  ): Promise<number | undefined> => {
    const nodes = session.surface.nodes;
    const first = nodes[1];
    const last = nodes.at(-1);
    if (first === undefined || last === undefined) return undefined;
    const shadowed = nodes.slice(1);
    const prices = meter?.measure?.(session).nodes ?? [];
    const shadowedTokenCount = prices
      .filter((node) => shadowed.includes(node.seq))
      .reduce((sum, node) => sum + node.heuristicTokens, 0);
    session.append("compaction/prune", {
      shadowedRange: { start: first, end: last },
      shadowedSeqs: shadowed,
      shadowedTokenCount,
    });
    const landed = session.append(
      "user/message",
      {
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: seed }],
        source: { kind: "user" },
      },
      { surfaceOp: { op: "replace", startSeq: first, endSeq: last }, sourceEventSeqs: shadowed },
    );
    await sessions?.flush?.(session);
    return landed.seq;
  };

  const original =
    controller !== undefined && typeof controller.prompt === "function"
      ? controller.prompt.bind(controller)
      : undefined;
  const target =
    controller === undefined
      ? undefined
      : (controller as unknown as { prompt: SessionControllerLike["prompt"] });

  const redirect = async (
    session: RotationSession,
    request: PromptRequestLike,
    signal: AbortSignal,
  ): Promise<{ accepted: boolean }> => {
    const fallback = (): Promise<{ accepted: boolean }> => original!(request, signal);
    if (meter === undefined || original === undefined) return fallback();
    const pressure = meter.contextPressure(session);
    const used = pressure.projectedTokens ?? pressure.pressureTokens;
    const window = pressure.contextWindow;
    if (used === undefined || window === undefined || window <= 0) return fallback();
    if (used < window * settings().rotateAt) return fallback();
    if (meter.measure === undefined || sessions?.flush === undefined) return fallback();
    const surface = asSurfaceSession(session);
    if (surface === undefined || rotating.has(session.id)) return fallback();
    // 轮询里正在跑的回合不能动表面：mid-turn 遮蔽会抽掉当前那一步之后要用的历史。
    const events = eventsOf(session);
    if (!turnClosed(events)) return fallback();
    const resetAt = resetSeqs.get(session.id);
    if (resetAt !== undefined && !advancedSince(events, resetAt)) return fallback();

    rotating.add(session.id);
    let cleared = false;
    try {
      const header = session.header ?? {};
      const workspace =
        header.cwd ?? workingDirectory?.get(session) ?? config.workspace ?? process.cwd();
      const checked = await runAutoCheck(session.id, workspace);
      const planReference = await boundPlan(session.id, workspace);
      const lastOutput = lastAssistantText(session);
      const seed = await buildSeed(workspace, domainRoot, {
        ...(lastOutput === undefined ? {} : { lastOutput }),
        ...(checked === undefined ? {} : { checked: checked.text }),
        ...(planReference === undefined ? {} : { planReference }),
      });
      const landed = await clearSurface(surface, seed);
      if (landed === undefined) return fallback();
      cleared = true;
      resetSeqs.set(session.id, landed);
      return await original(request, signal);
    } catch (error) {
      // 遮蔽是 append-only，落地后无法回滚；这条失败必须能与「没重置成功」区分开，否则现场只剩一次莫名其妙的失忆。
      const stage = cleared
        ? "history already shadowed but prompt was rejected"
        : "in-place reset failed";
      services.logger.warn(`nano-flow: ${stage}: ${describeError(error)}`);
      return fallback();
    } finally {
      rotating.delete(session.id);
    }
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

/**
 * 挂载压力触发的轮转包装（兼容入口）。
 * @param options - 宿主能力、领域根、设置与会话解析。
 * @returns 还原 prompt 包装的 disposer。
 */
export const attachRotation = (options: RotationOptions): (() => void) =>
  createRotation(options).attach();
