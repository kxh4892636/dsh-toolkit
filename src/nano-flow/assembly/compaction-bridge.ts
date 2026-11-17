/**
 * 压缩桥：跨 isolate realm 取预设里的压缩引擎。
 *
 * 预设把 `compaction-basic` 挂在 `isolate: { compaction: true }` 的 group 里，
 * 服务因此发布在 realm 私有 symbol 下，根作用域（agent 的 ctx）永远取不到它
 * （`dsh-agent-preset-registry` 的 `mount.ts` 把这算作 "correctly absent"）。
 *
 * 本包在同一个 bundle 里被挂两次：预设里的 `nano-flow` 行，以及压缩 group 内的
 * `nano-flow-compaction-bridge` 行。两次加载的是同一个 ES 模块，所以模块级变量
 * 跨 realm 可见——服务不行，变量可以。引擎由 group 内那一行登记进来，宿主半的
 * 轮转只读这个槽。
 */

/** 桥的签名：与 `compaction.compactNow(agent, signal)` 同形，只保留轮转要用的两个参数。 */
export type CompactionBridge = (agent: unknown, signal: AbortSignal) => Promise<unknown>;

/** 当前登记的桥；同一进程内以最后一次登记为准。 */
let bridge: CompactionBridge | undefined;

/**
 * 登记桥：由 realm 内的预设行调用。
 * @param fn - 调用该 realm 里压缩引擎的函数。
 * @returns 只撤销自己那一次的登记：先卸载的 mount 不会抹掉后登记的桥。
 */
export const setCompactionBridge = (fn: CompactionBridge): (() => void) => {
  bridge = fn;
  return () => {
    if (bridge === fn) bridge = undefined;
  };
};

/** 无条件清空槽；整体卸载与测试用。 */
export const clearCompactionBridge = (): void => {
  bridge = undefined;
};

/**
 * 读当前登记的桥。
 * @returns 桥；没有桥时 undefined，调用方按「本预设没有压缩引擎」处理。
 */
export const getCompactionBridge = (): CompactionBridge | undefined => bridge;
