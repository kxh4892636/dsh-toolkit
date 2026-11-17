/**
 * 就地撤回后的「已撤回行隐藏」：把墓碑事件声明的 seq 区间从对话里抹掉。
 *
 * 撤回不再换会话（`POST /api/toolkit/undo-turn` 就地追加一条墓碑），因此界面上
 * 消失这件事必须在客户端补：宿主会话窗口是只追加的，表面替换（`surfaceOp: replace`）
 * 只影响模型可见历史，已加载的行不会被移出窗口。
 *
 * 三件事，一件一层：
 * 1. **区间表**：墓碑事件（`system/message` + `data.recall`）流经时记下
 *    `{boundary, end}`；命中判断含两端。
 * 2. **定义层改写**：包住每个 `target: 'chat'` Definition 的 `buildViewNode`，
 *    行的 seq 落在区间内就返回同 key、`visibility: 'hidden'` 的节点 —— 聊天视图
 *    在快照里就把隐藏行过滤掉。不能返回 null：已物化的节点被撤回时宿主会抛
 *    `withdrew materialized target`（`assembler.ts:1059`）。
 * 3. **user 行接管**：抢 `conversation.chat.node` 的 `key: 'user'`（priority -1），
 *    区间内直接 `return null`，其余行委托宿主原组件渲染（气泡、复制按钮、图片都还是宿主的）。
 *
 * 活会话上墓碑落地时宿主不会重算已经物化的行，所以每记下一个**新**区间就
 * 重新注册一次自己的 definition：注册表变化会触发宿主整窗重装配，包过的
 * `buildViewNode` 随即重跑，刚撤回的行立刻消失（等价于刷新一次页面）。
 *
 * 拿不到 `uiConversation` 时整层降级为「只回填草稿、不隐藏」，不抛错。
 */

import { createElement, type ComponentType, type ReactNode } from "react";
import {
  clientService,
  hasMethod,
  type ClientContext,
  type ClientSlotEntry,
  type ConversationDefinitionLike,
  type ConversationEventLike,
  type ConversationEventsLike,
  type ConversationNodeContextLike,
  type ConversationViewNodeLike,
  type UiConversationLike,
} from "./contract.js";

/** 一段已撤回的 seq 区间；两端都含。 */
export interface RecalledRange {
  readonly boundary: number;
  readonly end: number;
}

/** 本插件 definition 的 kind，也是注册表里的键。 */
export const RECALL_DEFINITION_KIND = "toolkit-recall";

/** 只有聊天渲染单元带 `anchorSeq`/`visibility`，也只包这类 Definition。 */
const CHAT_TARGET = "chat";

/** 接管的那一格：用户消息行。 */
const CHAT_NODE_SLOT = "conversation.chat.node";

/** 抢格子用的优先级：比宿主默认的 0 更小（数值小的胜出）。 */
const USER_SEAT_PRIORITY = -1;

/** 宿主 `chat` 字典命名空间；委托渲染时宿主组件要用它翻译复制按钮等文案。 */
const CHAT_LOCALE = "chat";

/** 已撤回区间表；插件存活期间共享（seq 只在单个会话内唯一，命中判断按行传入）。 */
const ranges: RecalledRange[] = [];

/** 读当前全部区间（测试与诊断用）。 */
export const recalledRanges = (): readonly RecalledRange[] => ranges;

/**
 * 记一段已撤回区间（幂等）。
 *
 * 同一个切点只留一段：乐观更新用响应里的 `seq`（墓碑自己的 seq，比真实结尾大 1），
 * 墓碑事件落地时给的是更精确的 `end`。两者合并成一段，避免同一次撤回触发两次整窗重装配。
 * @param boundary - 第一行被撤回的 seq。
 * @param end - 最后一行被撤回的 seq。
 * @returns 区间是否真的变宽了（已知时为 false）。
 */
export const recordRecalledRange = (boundary: number, end: number): boolean => {
  if (!Number.isFinite(boundary) || !Number.isFinite(end) || end < boundary) return false;
  const existing = ranges.find((range) => range.boundary === boundary);
  if (existing !== undefined) {
    if (end <= existing.end) return false;
    ranges.splice(ranges.indexOf(existing), 1, { boundary, end });
    return true;
  }
  ranges.push({ boundary, end });
  ranges.sort((left, right) => left.boundary - right.boundary);
  return true;
};

/**
 * 某个 seq 是否落在任一已撤回区间内（含两端）。
 * @param seq - 行锚点或消息 seq；非数字一律视为未命中。
 * @returns 是否应隐藏。
 */
export const isRecalledSeq = (seq: unknown): boolean => {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return false;
  return ranges.some((range) => seq >= range.boundary && seq <= range.end);
};

/** 清空区间表（插件卸载与测试使用）。 */
export const resetRecalledRanges = (): void => {
  ranges.length = 0;
};

/** 安装后的运行时句柄：重装配要「现行 events 服务 + 现行注销器」。 */
interface RecallRuntime {
  readonly events: ConversationEventsLike;
  /** 注销本插件的 definition；重新注册即触发整窗重装配。 */
  disposeDefinition: () => void;
}

let runtime: RecallRuntime | undefined;
let rebuildQueued = false;

/**
 * 请求一次整窗重装配：注销并重新注册本插件的 definition。
 *
 * 宿主把注册表变化当作低频变更，会异步重建每个活动绑定的整窗视图
 * （`assembly.ts:229-251`）。同一轮多次请求合并成一次；重装配后重跑同一条墓碑
 * 只会命中已知区间，不会再次触发。
 */
export const scheduleRecallRebuild = (): void => {
  if (rebuildQueued) return;
  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    const current = runtime;
    if (current === undefined) return;
    try {
      current.disposeDefinition();
      current.disposeDefinition = current.events.register(recallDefinition);
    } catch {
      // 宿主拒绝重新注册（服务正在卸载）：区间表还在，下一轮重装配再生效。
    }
  });
};

/**
 * 本地记一段已撤回区间并请求重装配 —— 撤回成功后的乐观更新走这里，
 * 行在墓碑事件到达之前就先消失（墓碑落地时同一个切点只补精确结尾）。
 * @param boundary - 第一行被撤回的 seq。
 * @param end - 最后一行被撤回的 seq。
 * @returns 是否新记下（测试与诊断用）。
 */
export const hideRecalledRange = (boundary: number, end: number): boolean => {
  const recorded = recordRecalledRange(boundary, end);
  if (recorded) scheduleRecallRebuild();
  return recorded;
};

/** 从事件里读墓碑标记（`data.recall = {boundary, end}`）。 */
const recallMarkOf = (event: ConversationEventLike): RecalledRange | undefined => {
  const mark = event.data?.recall;
  if (typeof mark !== "object" || mark === null) return undefined;
  const record = mark as { boundary?: unknown; end?: unknown };
  const { boundary, end } = record;
  if (typeof boundary !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(boundary) || !Number.isFinite(end) || end < boundary) return undefined;
  return { boundary, end };
};

/**
 * 墓碑 Definition：只做状态承载（没有 target，不渲染任何行）。
 *
 * 匹配 `system/message` 且带 `data.recall` 的事件时记下区间并触发重装配；
 * 表面替换事件本来也不会被 `unknown-surface` 兜底（那个只认 append 面）。
 */
export const recallDefinition: ConversationDefinitionLike = {
  kind: RECALL_DEFINITION_KIND,
  match: (event) => {
    if (event.type !== "system/message") return null;
    const mark = recallMarkOf(event);
    if (mark === undefined) return null;
    if (recordRecalledRange(mark.boundary, mark.end)) scheduleRecallRebuild();
    return { id: String(event.seq), role: "start" };
  },
  start: (_context, match) => recallMarkOf(match.event) ?? { boundary: 0, end: 0 },
  update: (context) => context.state,
};

/**
 * 一个聊天节点可能代表的全部 seq。
 *
 * 大多数种类的锚点就是消息 seq；助手步骤把最终消息挂在 `data.finalNode`，
 * 轮尾挂在 `data.closing.finalNode`，少数种类（steering/context/turn-trigger）在 `data.seq`。
 * @param node - 宿主构建好的聊天节点。
 * @returns 候选 seq（只保留数字）。
 */
const nodeSeqCandidates = (node: ConversationViewNodeLike): number[] => {
  const data = (typeof node.data === "object" && node.data !== null ? node.data : {}) as {
    seq?: unknown;
    finalNode?: { seq?: unknown };
    closing?: { finalNode?: { seq?: unknown } };
  };
  return [node.anchorSeq, data.seq, data.finalNode?.seq, data.closing?.finalNode?.seq].filter(
    (seq): seq is number => typeof seq === "number",
  );
};

/**
 * 命中区间就给节点打上隐藏标记（保留 key/kind，宿主据此走增量改动）。
 * @param node - 宿主 `buildViewNode` 的产物。
 * @returns 原节点，或同 key 的隐藏版。
 */
export const hideRecalledNode = (node: ConversationViewNodeLike): ConversationViewNodeLike => {
  const recalled = nodeSeqCandidates(node).some((seq) => isRecalledSeq(seq));
  if (!recalled) return node;
  return node.visibility === "hidden" ? node : { ...node, visibility: "hidden" };
};

/** 已经包过的 Definition（避免同一对象被重复包装）。 */
const wrapped = new WeakSet<ConversationDefinitionLike>();

/**
 * 包住一个 Definition 的 `buildViewNode`。原构建器先跑，区间外的行完全不改。
 * @param definition - 宿主注册的 Definition。
 */
export const wrapDefinitionForRecall = (definition: ConversationDefinitionLike): void => {
  const original = definition.buildViewNode;
  if (typeof original !== "function" || wrapped.has(definition)) return;
  const builder = (context: ConversationNodeContextLike): ConversationViewNodeLike | null => {
    const node = original(context);
    return node === null ? node : hideRecalledNode(node);
  };
  try {
    definition.buildViewNode = builder;
  } catch {
    // 冻结的 Definition：跳过这一格，其余种类照旧隐藏。
    return;
  }
  wrapped.add(definition);
};

/**
 * 接管注册表里所有聊天 Definition（自己的墓碑 Definition 除外）。
 * @param events - `uiConversation.events`。
 */
export const wrapAllDefinitions = (events: ConversationEventsLike): void => {
  if (!hasMethod<ConversationEventsLike>(events, "entries")) return;
  let definitions: readonly ConversationDefinitionLike[];
  try {
    definitions = events.entries();
  } catch {
    return;
  }
  for (const definition of definitions) {
    if (definition.kind === RECALL_DEFINITION_KIND) continue;
    if (definition.target !== CHAT_TARGET) continue;
    wrapDefinitionForRecall(definition);
  }
};

/** 可渲染的 React 组件类型（普通函数，或 `memo`/`forwardRef` 的对象）。 */
const isRenderable = (value: unknown): boolean => {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { $$typeof?: unknown }).$$typeof;
  return tag === Symbol.for("react.memo") || tag === Symbol.for("react.forward_ref");
};

/**
 * 从宿主 slot 条目里找 `key: 'user'` 的原组件。
 *
 * 每行渲染时现查、不缓存：宿主包的注册可能晚于本插件，缓存会把「没找到」
 * 永久固化，于是一直走自绘降级。
 * @param slots - `ctx.slots`。
 * @returns 原组件，找不到时为 undefined。
 */
const hostUserComponent = (slots: ClientContext["slots"]): unknown => {
  if (typeof slots.entries !== "function") return undefined;
  let entries: readonly ClientSlotEntry[];
  try {
    entries = slots.entries(CHAT_NODE_SLOT);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.options?.key !== "user") continue;
    if (entry.component === UserRecallNodeView) continue;
    if (isRenderable(entry.component)) return entry.component;
  }
  return undefined;
};

/** 座位组件收到的 props：宿主 keyed Chat Node 的 props，这里只声明读到的字段。 */
interface SeatProps {
  readonly node?: ConversationViewNodeLike;
  /** 宿主翻译函数（本条目声明了 `chat` 字典命名空间）。 */
  readonly t?: (key: string) => string;
  /** 宿主的装饰链渲染入口；本条目声明不了那个子槽，通常缺省。 */
  readonly renderSlotChain?: unknown;
}

/** 用户消息行里的纯文本。 */
const userTextOf = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
  }
  return parts.join("");
};

/**
 * 宿主的 user 行组件要用它渲染「消息来源」装饰链；本插件的条目不能声明那个子槽
 * （宿主已声明，重复声明会被注册表拒绝），所以委托时补一条空链 ——
 * 与宿主给 pending 行用的 `NO_MESSAGE_SOURCE` 等价。
 */
const noMessageSource = (): null => null;

/** 安装时记下的 slots 服务：座位组件渲染时用它找宿主原组件。 */
let currentSlots: ClientContext["slots"] | undefined;

/**
 * 自绘降级行：宿主 user 组件取不到时用。只保证「消息还在、能读」。
 * @param props - 座位 props。
 * @returns 右对齐气泡。
 */
const UserRowFallback = (props: SeatProps): ReactNode => {
  const text = userTextOf((props.node?.data as { content?: unknown } | undefined)?.content);
  return createElement(
    "div",
    {
      style: { display: "flex", justifyContent: "flex-end", padding: "6px 0" },
      "data-toolkit-user-fallback": true,
    },
    createElement(
      "div",
      {
        style: {
          maxWidth: "min(525px, 82%)",
          borderRadius: "22px",
          padding: "10px 16px",
          fontSize: "16px",
          lineHeight: "24px",
          background: "var(--dsw-specific-bubble)",
          color: "var(--dsw-alias-label-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        },
      },
      text,
    ),
  );
};

/**
 * `conversation.chat.node` 的 `user` 座位：撤回过的消息直接不渲染，其余委托宿主原组件。
 *
 * 抢座位而不是替换整格，是因为 user 行的宿主组件声明了子槽、无法用同 priority 覆盖；
 * 这里只接管「是否渲染」与「转发 props」，气泡本身仍是宿主那份。
 * @param props - 座位 props（含节点、图片加载器、宿主翻译函数）。
 * @returns 行元素、宿主行、降级行，或 null（已撤回）。
 */
export const UserRecallNodeView = (props: SeatProps): ReactNode => {
  const node = props.node;
  if (node === undefined || nodeSeqCandidates(node).some((seq) => isRecalledSeq(seq))) {
    return null;
  }
  const Host = currentSlots === undefined ? undefined : hostUserComponent(currentSlots);
  if (Host !== undefined) {
    const forwarded: Record<string, unknown> = { ...props };
    if (typeof forwarded["renderSlotChain"] !== "function") {
      forwarded["renderSlotChain"] = noMessageSource;
    }
    return createElement(Host as ComponentType<Record<string, unknown>>, forwarded);
  }
  return UserRowFallback(props);
};

/** 安装结果。 */
export interface RecallHiding {
  /** 卸载：注销订阅、definition 与座位。 */
  readonly dispose: () => void;
}

/**
 * 安装「已撤回行隐藏」：注册墓碑 Definition、包住聊天 Definition 的构建器、
 * 抢 `user` 座位。依赖 `uiConversation`，拿不到时返回 undefined（整层降级）。
 * @param ctx - 客户端根上下文。
 * @returns 安装句柄；服务缺失时为 undefined。
 */
export const installRecallHiding = (ctx: ClientContext): RecallHiding | undefined => {
  const conversation = clientService<UiConversationLike>(ctx, "uiConversation");
  const events = conversation?.events;
  if (events === undefined || !hasMethod<ConversationEventsLike>(events, "register")) {
    return undefined;
  }
  if (runtime !== undefined) return undefined;
  currentSlots = ctx.slots;
  const disposeDefinition = events.register(recallDefinition);
  runtime = { events, disposeDefinition };
  wrapAllDefinitions(events);
  const unsubscribe =
    typeof events.subscribe === "function"
      ? events.subscribe(() => {
          wrapAllDefinitions(events);
        })
      : undefined;
  const disposeSeat = claimUserSeat(ctx);
  return {
    dispose: () => {
      if (typeof unsubscribe === "function") unsubscribe();
      try {
        runtime?.disposeDefinition();
      } catch {
        // 已注销：忽略。
      }
      runtime = undefined;
      currentSlots = undefined;
      disposeSeat();
    },
  };
};

/**
 * 抢 `conversation.chat.node` 的 `user` 格。
 *
 * 同一格同一优先级上已有条目时宿主会抛错（别的撤回插件先占了就是这种情形）：
 * 这里吞掉错误、保留上半层（构建器改写仍然生效），不让整包注册失败。
 * @param ctx - 客户端根上下文。
 * @returns 座位注销器（未注册时为空操作）。
 */
const claimUserSeat = (ctx: ClientContext): (() => void) => {
  const disposeInject = ctx.slots.inject(CHAT_NODE_SLOT, () => {
    try {
      return ctx.slots.register(
        {
          name: CHAT_NODE_SLOT,
          key: "user",
          priority: USER_SEAT_PRIORITY,
          locale: CHAT_LOCALE,
        },
        UserRecallNodeView,
      );
    } catch (error: unknown) {
      console.warn(
        `[dsh-toolkit] could not claim the ${CHAT_NODE_SLOT} "user" seat; recalled user rows rely on the definition-level hide:`,
        error,
      );
      return;
    }
  });
  return typeof disposeInject === "function" ? disposeInject : () => {};
};
