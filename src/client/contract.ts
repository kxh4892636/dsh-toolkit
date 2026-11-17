/**
 * 客户端半使用的宿主契约（结构性声明）。
 *
 * 宿主实装只发布 JS bundle，没有 d.ts；这里按实际用到的成员声明，出处写在注释里，
 * 形状漂移会在真机验收时暴露。全部成员都按「可缺省」处理，缺服务时插件降级而非崩溃。
 */

/** `ctx.slots.register` 接受的选项；只用到的字段需要类型。 */
export interface ClientSlotOptions {
  readonly name: string;
  /** list slot 用 id，keyed slot 用 key；两者互斥。 */
  readonly id?: string;
  readonly key?: string;
  readonly order?: number;
  /**
   * 同一 cell 内的选举优先级：数值小的条目胜出（宿主 SlotCore：
   * `register at a different priority to shadow it (lowest renders)`）。
   */
  readonly priority?: number;
  readonly label?: string | (() => string);
  readonly locale?: string;
  readonly inject?: (...args: readonly never[]) => Record<string, unknown>;
}

/** slot 组件签名；`never` 参数让它接受任意自有 props 类型。 */
type ClientSlotComponent = (props: never) => unknown;

/** `ctx.slots.entries(name)` 的一项：宿主已注册条目（含被遮挡的，未做选举）。 */
export interface ClientSlotEntry {
  readonly options?: {
    readonly key?: string;
    readonly id?: string;
    readonly priority?: number;
  };
  readonly component?: unknown;
}

/** `ctx.slots`：注册与「等声明出现再注册」（`dsh-client-ui-renderer/lib/client.js:1368-1394`）。 */
interface ClientSlots {
  /** 声明出现后回调；返回注销器（宿主 `SlotRegistry.inject`），老宿主可能不返回。 */
  inject(key: string, contribute: () => (() => void) | void): (() => void) | void;
  register(options: ClientSlotOptions, component: ClientSlotComponent): () => void;
  /** 已注册条目（宿主 `SlotRegistry.entries`）；老宿主缺这个方法时客户端半自行降级。 */
  entries?(key: string): readonly ClientSlotEntry[];
}

/** 客户端历史事件里本插件读取的部分（`SessionEventLike`）。 */
export interface ConversationEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly surfaceOp?: string;
  readonly data?: { readonly recall?: unknown; readonly [key: string]: unknown };
}

/** Definition 的匹配结果（宿主 `ConversationMatchResult`）。 */
export interface ConversationMatchResultLike {
  readonly id: string;
  readonly role: "start" | "update";
}

/** 一次被接受的 Match（宿主 `ConversationMatch`）。 */
export interface ConversationMatchLike {
  readonly event: ConversationEventLike;
  readonly role: "start" | "update";
}

/** Definition 上下文（宿主 `ConversationNodeContext` 的只读子集）。 */
export interface ConversationNodeContextLike {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly state: unknown;
}

/**
 * Conversation 视图节点（宿主 `ConversationViewNode` 的只读子集）。
 *
 * `target: 'chat'` 的节点带 `anchorSeq` 与 `visibility`；隐藏行靠后者表达 ——
 * 已物化的节点返回 null 会被宿主拒绝（`withdrew materialized target`）。
 */
export interface ConversationViewNodeLike {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly target?: string;
  readonly anchorSeq?: number;
  readonly visibility?: "visible" | "hidden";
  readonly data?: unknown;
}

/** 一个 Conversation Definition（宿主 `ConversationNodeDefinition` 的只读子集）。 */
export interface ConversationDefinitionLike {
  readonly kind: string;
  readonly target?: string;
  match: (event: ConversationEventLike) => ConversationMatchResultLike | null;
  start: (context: ConversationNodeContextLike, match: ConversationMatchLike) => unknown;
  update: (context: ConversationNodeContextLike, match: ConversationMatchLike) => unknown;
  /** 构建器；唯一允许被改写的成员（撤回靠包住它隐藏行）。 */
  buildViewNode?: (context: ConversationNodeContextLike) => ConversationViewNodeLike | null;
}

/** `uiConversation.events`：Definition 注册表（宿主 `ConversationEventRegistry`）。 */
export interface ConversationEventsLike {
  register(definition: ConversationDefinitionLike): () => void;
  entries(): readonly ConversationDefinitionLike[];
  subscribe?(listener: () => void): () => void;
}

/** 客户端 `uiConversation` 服务里本插件用到的部分。 */
export interface UiConversationLike {
  readonly events?: ConversationEventsLike;
}

/** 客户端根上下文里本插件会用到的部分。 */
export interface ClientContext {
  readonly slots: ClientSlots;
  get(key: string): unknown;
  effect(callback: () => (() => void) | void, label?: string): () => void;
  /** 客户端事件订阅（与宿主同一套 cordis 事件）；宿主半不可用时缺省。 */
  on?(event: string, handler: (...args: readonly unknown[]) => void): () => void;
  /** 依赖注入：服务就绪后回调子上下文（与 `ui-agent-preset` 等客户端插件同一套 cordis API）。 */
  inject?(dependencies: readonly string[], callback: (scope: ClientContext) => void): unknown;
}

/** 按名字取服务，缺失时返回 undefined。 */
export const clientService = <T>(
  ctx: { get(key: string): unknown },
  key: string,
): T | undefined => {
  try {
    return (ctx.get(key) as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
};

/** 结构性判断：服务上是否存在给定方法。 */
export const hasMethod = <T>(service: unknown, method: string): service is T => {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as Record<string, unknown>)[method] === "function"
  );
};
