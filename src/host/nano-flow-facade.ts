import type { NanoFlowSettings } from "../contract.js";

/** 根插件提供给预设内插件的服务名。 */
export const NANO_FLOW_SERVICE = "toolkitNanoFlow";

/**
 * 根插件（toolkit）对预设内 nano-flow 插件暴露的窄接口。
 *
 * 设置文件归根插件管：预设插件只读设置，避免两个实例同时写同一个状态文件。
 */
export interface ToolkitNanoFlowFacade {
  /** 当前生效的上限与轮转阈值。 */
  settings(): NanoFlowSettings;
  /** 合并并落盘设置。 */
  updateSettings(patch: unknown): Promise<NanoFlowSettings>;
  /** 写入或覆盖会话↔Plan 绑定；只有 nano_flow_bind 会调用。 */
  rebindSession(sessionId: string, planDirectory: string, workspace: string): Promise<void>;
}
