import type { UndoAvailability, UndoTurnResponse } from "../../contract.js";
import { describeError } from "../../shared/errors.js";
import {
  findUndoTarget,
  positiveInteger,
  type UndoSessionEvent,
  type UndoTarget,
} from "./turn-boundary.js";

/**
 * 撤回不可用的原因；路由层转成 409 与 `reason` 字段。
 *
 * `agent-busy` 只在会话正在跑一轮时出现：就地撤回要改写当前表面，
 * 而运行中的那一轮还在往上追加，必须等它停下。
 */
type UndoUnavailableReason =
  | "session-not-live"
  | "no-previous-turn"
  | "agent-busy"
  | "unsupported-host";

/** 撤回不可用：UI 据此置灰按钮或提示。 */
export class UndoUnavailableError extends Error {
  readonly reason: UndoUnavailableReason;

  constructor(reason: UndoUnavailableReason, message: string) {
    super(message);
    this.name = "UndoUnavailableError";
    this.reason = reason;
  }
}

/** 会话表面：`dsh-session` 的 `session.surface.nodes`，当前表面节点按首到尾排列。 */
export interface RecallSurface {
  readonly nodes: readonly number[];
}

/** 会话事件上的 `surfaceOp` 写入项。 */
export interface UndoAppendOptions {
  readonly surfaceOp?: unknown;
  readonly sourceEventSeqs?: readonly number[];
}

/**
 * 存活会话上撤回所需的可写子集（`dsh-session` 的 `Session`）。
 *
 * 三个字段都按可选声明并按方法探测：宿主不提供就地写表面时，撤回整体判为
 * `unsupported-host`，而不是在某个字段上炸掉。
 */
export interface UndoSession {
  snapshotEvents(): readonly UndoSessionEvent[];
  /** 下一个事件的 seq（`session.seq` 等于日志长度）。 */
  readonly seq?: number;
  readonly surface?: RecallSurface;
  append?(type: string, data: unknown, opts?: UndoAppendOptions): { readonly seq?: number };
}

/** 会话存储：查找存活会话，并给一次追加落盘屏障（`sessions.flush`）。 */
export interface UndoSessionStore {
  get(id: string): UndoSession | undefined;
  flush?(session: UndoSession): Promise<unknown>;
}

/**
 * 会话控制器上撤回用到的队列能力
 * （`dsh-api-session-controller/lib/index.js:1006` 的 `updateQueue`、`2309` 的 `state`）。
 *
 * 只用于清掉排队中的输入；宿主不暴露时撤回照常进行，只记一条 warn。
 */
export interface UndoQueueController {
  state?(
    request: { readonly sessionId: string },
    signal: AbortSignal,
  ): Promise<{ readonly queue?: readonly { readonly id: string }[] | null }>;
  updateQueue?(request: {
    readonly sessionId: string;
    readonly itemId: string;
    readonly action: { readonly kind: "remove" };
  }): Promise<unknown>;
}

/** 客户端可选的撤回锚点：确认弹窗知道自己要撤哪条消息时可以带上。 */
export interface UndoAnchor {
  readonly messageId?: string;
  /** 期望的撤回切点（被撤回那轮用户消息的 seq）。 */
  readonly boundary?: number;
}

/** 宿主 agents 服务的读取子集：取某会话的 agent 看它在不在跑（`dsh-agent` 的 `ctx.agents`）。 */
export interface UndoAgentLookup {
  get(id: string): { readonly status?: string } | undefined;
}

/** 就地撤回所需的宿主能力。 */
export interface UndoDeps {
  readonly sessions: UndoSessionStore;
  /** 排队输入的清理能力；宿主没有 `sessionController` 时省略。 */
  readonly controller?: UndoQueueController;
  /** 运行状态探测；宿主没有 `agents` 时省略（此时不做忙碌检查）。 */
  readonly agents?: UndoAgentLookup;
  readonly logger: { warn(message: string): void };
}

/** `state` 只需要一个不会被取消的信号：撤回本身没有可取消的上游。 */
const NEVER_ABORTED = new AbortController().signal;

/**
 * 探测某会话能否撤回。
 * @param deps - 宿主能力。
 * @param sessionId - 目标会话。
 * @returns 可用性、不可用原因，以及被撤销那一轮的用户原文。
 */
export const inspectUndo = (deps: UndoDeps, sessionId: string): UndoAvailability => {
  try {
    const { target } = resolveTarget(deps, sessionId);
    return { available: true, prompt: target.prompt };
  } catch (error) {
    if (error instanceof UndoUnavailableError) return { available: false, reason: error.reason };
    throw error;
  }
};

/**
 * 就地撤回最后一轮：在同一个会话里追加一条墓碑，让模型可见的历史停在上一轮结束。
 *
 * 只写**一个**事件：一条空内容的 `system/message`，用 `surfaceOp.replace` 覆盖
 * `boundary..end` 这段表面，并在 `sourceEventSeqs` 里点名每一个被遮蔽节点；
 * `data.recall` 留给客户端半隐藏这些行。会话 id 不变，也不动会话日志与工作区记账。
 *
 * 写之前先把排队中的输入清掉：否则撤回完成后那条待发消息会随即开一轮，
 * 把刚遮蔽的历史重新长出来。
 * @param deps - 宿主能力。
 * @param sessionId - 被撤回的会话。
 * @param anchor - 客户端确认时携带的锚点；与最后一轮不符时拒绝。
 * @returns 撤回切点、墓碑 seq 与被撤回那一轮的用户原文。
 */
export const undoTurn = async (
  deps: UndoDeps,
  sessionId: string,
  anchor?: UndoAnchor,
): Promise<UndoTurnResponse> => {
  // 先确认可撤回：清队列有副作用，不能在不可撤回的会话上白清一遍。
  assertAnchor(resolveTarget(deps, sessionId), anchor);
  await clearQueue(deps, sessionId);
  // 清队列会写 inbox 事件、甚至开一轮；落笔前按最新表面重算切点。
  const resolved = resolveTarget(deps, sessionId);
  assertAnchor(resolved, anchor);
  const recall = recallOf(resolved.session, resolved.target);
  const appended = resolved.session.append!("system/message", recall.data, recall.opts);
  await flush(deps, resolved.session);
  return {
    boundary: recall.boundary,
    seq: appended.seq ?? recall.seq,
    prompt: resolved.target.prompt,
  };
};

/** 已校验的撤回目标：会话、切点与墓碑形状。 */
interface ResolvedUndo {
  readonly session: RecallSession;
  readonly target: UndoTarget;
}

/** 探到 `append` + `surface` 的会话；撤回只在这种会话上成立。 */
interface RecallSession extends UndoSession {
  readonly surface: RecallSurface;
  append(type: string, data: unknown, opts?: UndoAppendOptions): { readonly seq?: number };
}

/** 一次墓碑写入的东西：`system/message` 的 data、表面写入项与切点。 */
interface RecallPlan {
  readonly boundary: number;
  readonly seq: number;
  readonly data: Record<string, unknown>;
  readonly opts: UndoAppendOptions;
}

const resolveTarget = (deps: UndoDeps, sessionId: string): ResolvedUndo => {
  const session = deps.sessions.get(sessionId);
  if (session === undefined) {
    throw new UndoUnavailableError(
      "session-not-live",
      `session "${sessionId}" is not live in this host`,
    );
  }
  if (deps.agents?.get(sessionId)?.status === "running") {
    throw new UndoUnavailableError(
      "agent-busy",
      `session "${sessionId}" is running; stop the current turn before undoing`,
    );
  }
  const recallable = asRecallSession(session);
  if (recallable === undefined) {
    throw new UndoUnavailableError(
      "unsupported-host",
      `session "${sessionId}" exposes no writable surface for an in-place recall`,
    );
  }
  const target = findUndoTarget(recallable.snapshotEvents());
  if (target === undefined) {
    throw new UndoUnavailableError("no-previous-turn", "there is no earlier turn to return to");
  }
  // 切点必须仍停在该会话的当前表面上：早先被遮蔽（已撤回、被压缩）的消息不能当锚。
  if (!recallable.surface.nodes.includes(target.boundarySeq)) {
    throw new UndoUnavailableError(
      "no-previous-turn",
      `the message at seq ${target.boundarySeq} is no longer part of the conversation`,
    );
  }
  return { session: recallable, target };
};

const asRecallSession = (session: UndoSession): RecallSession | undefined => {
  if (typeof session.append !== "function") return undefined;
  if (!Array.isArray(session.surface?.nodes)) return undefined;
  return session as RecallSession;
};

/** 客户端锚点与最后一轮对不上时拒绝：宁可报不可撤回，也不悄悄撤掉别的一轮。 */
const assertAnchor = (resolved: ResolvedUndo, anchor: UndoAnchor | undefined): void => {
  if (anchor === undefined) return;
  const boundary = resolved.target.boundarySeq;
  if (anchor.boundary !== undefined && anchor.boundary !== boundary) {
    throw new UndoUnavailableError(
      "no-previous-turn",
      `the event at seq ${anchor.boundary} is not the user message of the last turn`,
    );
  }
  if (anchor.messageId === undefined) return;
  const event = resolved.session.snapshotEvents()[boundary];
  if (messageIdOf(event?.data) !== anchor.messageId) {
    throw new UndoUnavailableError(
      "no-previous-turn",
      `message "${anchor.messageId}" is not the last turn's user message`,
    );
  }
};

/** 消息 id：用户消息的 data 就是消息本身，assistant 消息嵌在 `data.message` 下。 */
const messageIdOf = (data: unknown): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as { id?: unknown; message?: unknown };
  if (typeof record.id === "string" && record.id !== "") return record.id;
  const nested = record.message;
  if (typeof nested !== "object" || nested === null) return undefined;
  const id = (nested as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

/**
 * 从当前表面算出墓碑：切点到表面结尾整段被替换，结尾节点就是 `end`。
 *
 * `turn`/`step` 只是让这一行通过 v4 准入（正整数）：墓碑没有自己的轮次语义，
 * 借用被撤回那条消息所在轮的坐标，推不出来时退回 1。
 */
const recallOf = (session: RecallSession, target: UndoTarget): RecallPlan => {
  const nodes = session.surface.nodes;
  const boundary = target.boundarySeq;
  const start = nodes.indexOf(boundary);
  const shadowed = nodes.slice(start);
  const end = shadowed[shadowed.length - 1] ?? boundary;
  const events = session.snapshotEvents();
  const source = dataOf(events[boundary]);
  const seq = session.seq ?? events.length;
  const turn = positiveInteger(source["turn"]) ?? target.turn;
  const step = positiveInteger(source["step"]) ?? 1;
  return {
    boundary,
    seq,
    data: {
      turn,
      step,
      recall: { boundary, end },
      message: {
        id: `recall-${seq}-${boundary}`,
        role: "system",
        source: { kind: "system-prompt" },
        content: [],
      },
    },
    opts: {
      surfaceOp: { op: "replace", startSeq: boundary, endSeq: end },
      sourceEventSeqs: [...shadowed],
    },
  };
};

const dataOf = (event: UndoSessionEvent | undefined): Record<string, unknown> => {
  const data = event?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
};

/** 追加之后等一次落盘屏障；失败只 warn（墓碑已在存活会话里，撤回已经生效）。 */
const flush = async (deps: UndoDeps, session: UndoSession): Promise<void> => {
  const store = deps.sessions;
  if (typeof store.flush !== "function") {
    deps.logger.warn(
      "toolkit: the session store exposes no flush; the recall mark may not be durable",
    );
    return;
  }
  try {
    await store.flush(session);
  } catch (error) {
    deps.logger.warn(`toolkit: flushing the recall mark failed: ${describeError(error)}`);
  }
};

/** 清掉排队中的输入：逐条 `updateQueue({action:{kind:"remove"}})`，任何一步失败都只 warn。 */
const clearQueue = async (deps: UndoDeps, sessionId: string): Promise<void> => {
  const controller = deps.controller;
  if (
    controller === undefined ||
    typeof controller.state !== "function" ||
    typeof controller.updateQueue !== "function"
  ) {
    deps.logger.warn(
      `toolkit: cannot clear the pending input of "${sessionId}": the host exposes no session queue`,
    );
    return;
  }
  let queued: readonly { readonly id: string }[];
  try {
    const state = await controller.state({ sessionId }, NEVER_ABORTED);
    queued = state.queue ?? [];
  } catch (error) {
    deps.logger.warn(
      `toolkit: reading the queue of "${sessionId}" failed: ${describeError(error)}`,
    );
    return;
  }
  for (const item of queued) {
    try {
      await controller.updateQueue({ sessionId, itemId: item.id, action: { kind: "remove" } });
    } catch (error) {
      deps.logger.warn(
        `toolkit: removing queued input "${item.id}" failed: ${describeError(error)}`,
      );
    }
  }
};
