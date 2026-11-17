/**
 * 撤回目标的纯计算：在会话事件序列上定位「最后一轮」，取出撤回切点（该轮的用户消息）
 * 与该轮的用户原文。只读事件数组，不依赖宿主对象，便于单测覆盖边界（首轮、运行中一轮、多段输入）。
 */

/** 会话事件的最小形状；`seq` 与数组下标一致（日志从 0 连续）。 */
export interface UndoSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly data?: unknown;
  /** 表面标记：`append` 是该事件追加到表面尾部，`{op:'replace'}` 是替换，缺省是日志独有事件。 */
  readonly surfaceOp?: unknown;
}

/** 撤回目标：被撤销的一轮、墓碑 replace 的起点与该轮的用户原文。 */
export interface UndoTarget {
  /** 被撤销那一轮的编号（`turn/start` 的 `turn`，缺失时按出现次数）。 */
  readonly turn: number;
  /** 该轮 `turn/start` 的 seq。 */
  readonly turnStartSeq: number;
  /** 撤回切点：该轮第一条用户消息的 seq，也是墓碑 replace 区间的起点。 */
  readonly boundarySeq: number;
  /** 该轮用户输入原文，多段以空行连接；没有任何用户文本时为空串。 */
  readonly prompt: string;
}

/**
 * 找出「撤回最后一轮」所需的切点与原文。
 *
 * 切点取该轮第一条**用户消息**：就地撤回想让模型看到的历史停在上一轮结束，
 * 只有落在消息节点上才能用 `surfaceOp.replace` 精确覆盖。用户消息缺席（一轮里
 * 没有用户文本，或整轮被取消）时退回该轮第一条 assistant 消息；两者都没有就没得撤。
 * @param events - 完整或尾部已加载的事件序列。
 * @returns 切点信息；会话没有任何轮次、最后一轮是首轮（前面没有可回到的状态），
 * 或该轮没有任何表面消息时为 undefined。
 */
export const findUndoTarget = (events: readonly UndoSessionEvent[]): UndoTarget | undefined => {
  const lastIndex = lastTurnStartIndex(events);
  const start = lastIndex < 0 ? undefined : events[lastIndex];
  if (start === undefined) return undefined;
  if (!hasEarlierTurn(events, lastIndex)) return undefined;
  const boundarySeq = boundaryOfTurn(events, start.seq);
  if (boundarySeq === undefined) return undefined;
  return {
    turn: turnOf(start, events, lastIndex),
    turnStartSeq: start.seq,
    boundarySeq,
    prompt: promptOfTurn(events, start.seq),
  };
};

const lastTurnStartIndex = (events: readonly UndoSessionEvent[]): number => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/start") return index;
  }
  return -1;
};

/** 撤回要回到「上一轮结束」：最后一轮之前必须还有一轮。 */
const hasEarlierTurn = (events: readonly UndoSessionEvent[], lastIndex: number): boolean => {
  for (let index = 0; index < lastIndex; index += 1) {
    if (events[index]?.type === "turn/start") return true;
  }
  return false;
};

/**
 * 该轮的撤回切点：第一条用户消息，缺席时退回第一条 assistant 消息。
 *
 * 只有 `surfaceOp === "append"` 的节点能当切点：它必须仍以原样停在当前表面里，
 * 替换出来的节点（种子、墓碑）洗过一遍就不能再当锚。
 * @param events - 事件序列。
 * @param startSeq - 目标轮 `turn/start` 的 seq。
 * @returns 切点 seq；该轮没有任何可撤回的表面消息时为 undefined。
 */
const boundaryOfTurn = (
  events: readonly UndoSessionEvent[],
  startSeq: number,
): number | undefined => {
  let assistant: number | undefined;
  for (const event of events) {
    if (event.seq <= startSeq) continue;
    if (event.type === "turn/start" || event.type === "turn/end") break;
    if (!isAppended(event)) continue;
    if (event.type === "user/message" && isUserAuthored(event.data)) return event.seq;
    if (event.type === "assistant/message" && assistant === undefined) assistant = event.seq;
  }
  return assistant;
};

/** 追加到表面尾部的事件（`session.append` 默认写入的标记）。 */
const isAppended = (event: UndoSessionEvent): boolean => event.surfaceOp === "append";

/** 轮次编号：优先用 `turn/start` 自己声明的轮次，缺失时按出现次数。 */
const turnOf = (
  start: UndoSessionEvent,
  events: readonly UndoSessionEvent[],
  lastIndex: number,
): number => {
  const declared = positiveInteger(dataOf(start)["turn"]);
  if (declared !== undefined) return declared;
  let count = 0;
  for (let index = 0; index <= lastIndex; index += 1) {
    if (events[index]?.type === "turn/start") count += 1;
  }
  return Math.max(count, 1);
};

/** 正整数，或 undefined：墓碑行只接受这种形状。 */
export const positiveInteger = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/** 收集一轮内用户实际输入的文本片段；运行时上下文等注入消息被排除。 */
const promptOfTurn = (events: readonly UndoSessionEvent[], startSeq: number): string => {
  const parts: string[] = [];
  for (const event of events) {
    if (event.seq <= startSeq) continue;
    if (event.type === "turn/start" || event.type === "turn/end") break;
    if (event.type !== "user/message") continue;
    if (!isUserAuthored(event.data)) continue;
    const text = textOf(event.data);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n\n");
};

const dataOf = (event: UndoSessionEvent): Record<string, unknown> => {
  const data = event.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
};

const isUserAuthored = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) return false;
  const source = (data as { source?: unknown }).source;
  if (typeof source !== "object" || source === null) return true;
  const kind = (source as { kind?: unknown }).kind;
  return kind === undefined || kind === "user";
};

const textOf = (data: unknown): string => {
  if (typeof data !== "object" || data === null) return "";
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") texts.push(candidate.text);
  }
  return texts.join("\n");
};
