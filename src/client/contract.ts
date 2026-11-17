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
  readonly label?: string | (() => string);
}

/** slot 组件签名；`never` 参数让它接受任意自有 props 类型。 */
type ClientSlotComponent = (props: never) => unknown;

/** `ctx.slots`：注册与「等声明出现再注册」（`dsh-client-ui-renderer/lib/client.js:1368-1394`）。 */
interface ClientSlots {
  /** 声明出现后回调；返回注销器（宿主 `SlotRegistry.inject`），老宿主可能不返回。 */
  inject(key: string, contribute: () => (() => void) | void): (() => void) | void;
  register(options: ClientSlotOptions, component: ClientSlotComponent): () => void;
}

/** 客户端根上下文里本插件会用到的部分。 */
export interface ClientContext {
  readonly slots: ClientSlots;
  get(key: string): unknown;
  effect(callback: (() => void) | void, label?: string): () => void;
}
