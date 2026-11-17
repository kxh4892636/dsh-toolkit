/** 默认领域根；与 `nano-flow/prompt.md` 的约定一致。 */
export const DEFAULT_DOMAIN_ROOT = ".agents/domains";

/**
 * 插件配置。
 *
 * 预设行挂载时只传 `domainRoot`（或什么都不传）；`workspace` 用于测试与
 * 「会话工作目录不可用」的兜底。
 */
export interface Config {
  /** 工作区根；缺省取会话工作目录，再缺省取进程工作目录。 */
  workspace?: string;
  /** 领域根（相对工作区根或绝对路径）；缺省 `.agents/domains`。 */
  domainRoot?: string;
  /**
   * 预设行开关：只把该 realm 的压缩引擎登记进模块级桥，不注册工具、技能与提示词。
   * 这一行挂在 `isolate: { compaction: true }` 的 group 里，是轮转唯一能看到引擎的途径。
   */
  compactBridgeOnly?: boolean;
}
