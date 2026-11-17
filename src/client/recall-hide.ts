/**
 * 就地撤回后的「已撤回行隐藏」：把墓碑事件声明的 seq 区间从对话里抹掉。
 *
 * 撤回不再换会话（`POST /api/toolkit/undo-turn` 就地追加一条墓碑），因此界面上
 * 消失这件事必须在客户端补：宿主会话窗口是只追加的，表面替换（`surfaceOp: replace`）
 * 只影响模型可见历史，已加载的行不会被移出窗口。
 *
 * 两件事，一件一层：
 * 1. **区间表**：墓碑事件（`system/message` + `data.recall`）流经时记下
 *    `{sessionId, boundary, end}`；命中判断含两端，且只命中当前会话的区间 ——
 *    每个会话的 seq 都从 0 开始，区间不隔离就会在别的会话里误藏。
 * 2. **定义层改写**：包住每个 `target: 'chat'` Definition 的 `buildViewNode`，
 *    行的 seq 落在区间内就返回同 key、`visibility: 'hidden'` 的节点 —— 聊天视图
 *    在快照里就把隐藏行过滤掉。不能返回 null：已物化的节点被撤回时宿主会抛
 *    `withdrew materialized target`（`assembler.ts:1059`）。
 *
 * 用户行也走这一层：宿主自己的 `messageDefinition` 就是 `target: 'chat'`
 * （`dsh-client-ui-chat/src/client/conversation-nodes/message.ts:82-84`），
 * 改它的 `buildViewNode` 已经能隐藏用户消息行。不要再抢 `conversation.chat.node`
 * 的座位：座位会给宿主 user 行补空装饰链，消息来源、引用标签这些装饰会掉。
 *
 * 活会话上墓碑落地时宿主不会重算已经物化的行，所以每记下一个**新**区间就
 * 重新注册一次自己的 definition：注册表变化会触发宿主整窗重装配，包过的
 * `buildViewNode` 随即重跑，刚撤回的行立刻消失（等价于刷新一次页面）。
 *
 * 拿不到 `uiConversation` 时整层降级为「只回填草稿、不隐藏」，不抛错。
 */

import {
  clientService,
  hasMethod,
  type ClientContext,
  type ConversationDefinitionLike,
  type ConversationEventLike,
  type ConversationEventsLike,
  type ConversationNodeContextLike,
  type ConversationViewNodeLike,
  type UiConversationLike,
} from "./contract.js";

/** 一段已撤回的 seq 区间；两端都含，且只对 `sessionId` 那个会话成立。 */
export interface RecalledRange {
  /** 区间所属会话：seq 只在单个会话内唯一，跨会话必须隔离。 */
  readonly sessionId: string;
  readonly boundary: number;
  readonly end: number;
}

/** 本插件 definition 的 kind，也是注册表里的键。 */
export const RECALL_DEFINITION_KIND = "toolkit-recall";

/** 只有聊天渲染单元带 `anchorSeq`/`visibility`，也只包这类 Definition。 */
const CHAT_TARGET = "chat";

/** 已撤回区间表；插件存活期间共享，每条都带会话。 */
const ranges: RecalledRange[] = [];

/** 当前正在看的会话；未设置时一律不命中（宁可先不隐藏，也不跨会话乱藏）。 */
let activeSession: string | undefined;

/** 读当前全部区间（测试与诊断用）。 */
export const recalledRanges = (): readonly RecalledRange[] => ranges;

/**
 * 记住当前正在看的会话；切换时请求一次重装配。
 *
 * 来源是 composer 上「撤回」按钮的 `sessionId`（`conversation.input.right` 的标准 props），
 * 每次渲染都会同步一次：切会话后整窗重装配，旧会话的区间立刻不再命中新会话的行。
 * @param sessionId - 宿主的会话 id。
 */
export const setActiveSession = (sessionId: string): void => {
  if (activeSession === sessionId) return;
  activeSession = sessionId;
  scheduleRecallRebuild();
};

/**
 * 记一段已撤回区间（幂等，同会话同切点只留一段）。
 *
 * 同一个切点只留一段：乐观更新用响应里的 `seq`（墓碑自己的 seq，比真实结尾大 1），
 * 墓碑事件落地时给的是更精确的 `end`。两者合并成一段，避免同一次撤回触发两次整窗重装配。
 * @param sessionId - 区间所属会话。
 * @param boundary - 第一行被撤回的 seq。
 * @param end - 最后一行被撤回的 seq。
 * @returns 区间是否真的变宽了（已知时为 false）。
 */
export const recordRecalledRange = (sessionId: string, boundary: number, end: number): boolean => {
  if (!Number.isFinite(boundary) || !Number.isFinite(end) || end < boundary) return false;
  const existing = ranges.find(
    (range) => range.sessionId === sessionId && range.boundary === boundary,
  );
  if (existing !== undefined) {
    if (end <= existing.end) return false;
    ranges.splice(ranges.indexOf(existing), 1, { sessionId, boundary, end });
    return true;
  }
  ranges.push({ sessionId, boundary, end });
  ranges.sort((left, right) => left.boundary - right.boundary);
  return true;
};

/**
 * 某个 seq 是否落在**当前会话**的任一已撤回区间内（含两端）。
 * @param seq - 行锚点或消息 seq；非数字一律视为未命中。
 * @returns 是否应隐藏；当前会话未知时一律 false。
 */
export const isRecalledSeq = (seq: unknown): boolean => {
  if (typeof seq !== "number" || !Number.isFinite(seq)) return false;
  const session = activeSession;
  if (session === undefined) return false;
  return ranges.some(
    (range) => range.sessionId === session && seq >= range.boundary && seq <= range.end,
  );
};

/** 清空区间表与当前会话（插件卸载与测试使用）。 */
export const resetRecalledRanges = (): void => {
  ranges.length = 0;
  activeSession = undefined;
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
 * @param sessionId - 区间所属会话。
 * @param boundary - 第一行被撤回的 seq。
 * @param end - 最后一行被撤回的 seq。
 * @returns 是否新记下（测试与诊断用）。
 */
export const hideRecalledRange = (sessionId: string, boundary: number, end: number): boolean => {
  const recorded = recordRecalledRange(sessionId, boundary, end);
  if (recorded) scheduleRecallRebuild();
  return recorded;
};

/** 从事件里读墓碑标记（`data.recall = {sessionId, boundary, end}`）。 */
const recallMarkOf = (event: ConversationEventLike): RecalledRange | undefined => {
  const mark = event.data?.recall;
  if (typeof mark !== "object" || mark === null) return undefined;
  const record = mark as { sessionId?: unknown; boundary?: unknown; end?: unknown };
  const { sessionId, boundary, end } = record;
  if (typeof sessionId !== "string" || sessionId === "") return undefined;
  if (typeof boundary !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(boundary) || !Number.isFinite(end) || end < boundary) return undefined;
  return { sessionId, boundary, end };
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
    if (recordRecalledRange(mark.sessionId, mark.boundary, mark.end)) scheduleRecallRebuild();
    return { id: String(event.seq), role: "start" };
  },
  start: (_context, match) => recallMarkOf(match.event) ?? { sessionId: "", boundary: 0, end: 0 },
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

/** 安装结果。 */
export interface RecallHiding {
  /** 卸载：注销订阅与 definition。 */
  readonly dispose: () => void;
}

/**
 * 安装「已撤回行隐藏」：注册墓碑 Definition + 包住聊天 Definition 的构建器。
 * 依赖 `uiConversation`，拿不到时返回 undefined（整层降级）。
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
  const disposeDefinition = events.register(recallDefinition);
  runtime = { events, disposeDefinition };
  wrapAllDefinitions(events);
  const unsubscribe =
    typeof events.subscribe === "function"
      ? events.subscribe(() => {
          wrapAllDefinitions(events);
        })
      : undefined;
  return {
    dispose: () => {
      if (typeof unsubscribe === "function") unsubscribe();
      try {
        runtime?.disposeDefinition();
      } catch {
        // 已注销：忽略。
      }
      runtime = undefined;
    },
  };
};
