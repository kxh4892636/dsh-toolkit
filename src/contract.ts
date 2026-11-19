/**
 * 宿主半与客户端半共享的契约：工具目录与开关的形状。
 * 客户端 bundle 直接内联本模块（相对导入会被打包），因此这里不得引入任何宿主依赖。
 */

/** 工具在面板中的一项：标题与说明用于展示，`enabled` 是宿主当前生效的状态。 */
export interface ToolkitToolInfo {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
}

/** `GET /api/toolkit/state` 的响应。 */
export interface ToolkitStateResponse {
  readonly tools: readonly ToolkitToolInfo[];
}

/** `POST /api/toolkit/state` 的请求体。 */
export interface ToolkitStateRequest {
  readonly id: string;
  readonly enabled: boolean;
}

/** 宿主路由的错误体；客户端据 `error` 选择本地化文案。 */
export interface ToolkitErrorBody {
  readonly error: string;
  readonly message: string;
}

/** 宿主工具目录路由（连接服务已鉴权，客户端用同源相对地址调用）。 */
export const TOOLKIT_STATE_PATH = "/api/toolkit/state";

/**
 * Nano Flow 的数值上限与轮转阈值；由 toolkit 面板的设置区维护，
 * 持久化在 `$DSH_HOME/toolkit/nano-flow.json`。
 */
export interface NanoFlowSettings {
  /** spec.md 单文件上限（字节）。 */
  readonly specMaxBytes: number;
  /** 单条 note 正文上限（字节）。 */
  readonly noteMaxBytes: number;
  /** description 的字数上限。 */
  readonly noteDescriptionMaxChars: number;
  /** CONTEXT.md 上限（字节）。 */
  readonly contextMaxBytes: number;
  /** 单个 question 上限（字节）。 */
  readonly questionMaxBytes: number;
  /** 单个 ADR 上限（字节）。 */
  readonly adrMaxBytes: number;
  /** 单个 workflow 上限（字节）。 */
  readonly workflowMaxBytes: number;
  /** GUIDE.md 上限（字节）；dream 维护的注入层索引。 */
  readonly guideMaxBytes: number;
  /** 上下文占用达到最大上下文的这个比例后轮转会话（0–1）。 */
  readonly rotateAt: number;
}

/** 默认值（面板按 KB 显示）：34 / 13 KB，144 字，89 / 13 / 8 / 34 KB，GUIDE 21 KB，轮转阈值 0.55。 */
export const DEFAULT_NANO_FLOW_SETTINGS: NanoFlowSettings = {
  specMaxBytes: 34 * 1024,
  noteMaxBytes: 13 * 1024,
  noteDescriptionMaxChars: 144,
  contextMaxBytes: 89 * 1024,
  questionMaxBytes: 13 * 1024,
  adrMaxBytes: 8 * 1024,
  workflowMaxBytes: 34 * 1024,
  guideMaxBytes: 21 * 1024,
  rotateAt: 0.55,
};

/** `GET /api/toolkit/nano-flow` 的响应体。 */
export interface NanoFlowSettingsResponse {
  readonly settings: NanoFlowSettings;
}

/** `POST /api/toolkit/nano-flow` 的请求体：只提交要改的字段。 */
export interface NanoFlowSettingsRequest {
  readonly patch: Partial<NanoFlowSettings>;
}

/** Nano Flow 设置路由（连接服务已鉴权）。 */
export const TOOLKIT_NANO_FLOW_PATH = "/api/toolkit/nano-flow";

/** 面板展示的 note 状态：完成的 note 不进面板。 */
export const PANEL_STATUSES = ["pending", "in_progress", "blocked"] as const;

/** 面板 note 状态。 */
export type PanelNoteStatus = (typeof PANEL_STATUSES)[number];

/** 面板里的一条 note。 */
export interface PanelNote {
  readonly name: string;
  readonly status: PanelNoteStatus;
  readonly description: string;
  /** `blocked` 时写清在等什么；其他状态没有这个字段。 */
  readonly reason?: string;
  /** 单行下一步；缺省表示没有。 */
  readonly nextStep?: string;
}

/** 面板快照；`planPath` 相对工作区。 */
export interface NotesSnapshot {
  readonly planName: string;
  readonly planPath: string;
  readonly notes: readonly PanelNote[];
}

/** `GET /api/toolkit/nano-flow/notes` 的响应；`null` 表示当前会话没有可展示的 note。 */
export interface NanoFlowNotesResponse {
  readonly snapshot: NotesSnapshot | null;
}

/** Note 面板轮询宿主路由的节奏。 */
export const NANO_FLOW_NOTES_REFRESH_MS = 5_000;

/** Note 面板快照路由（连接服务已鉴权）。 */
export const TOOLKIT_NANO_FLOW_NOTES_PATH = "/api/toolkit/nano-flow/notes";

/** 工具 id；状态文件与面板都以此为键。 */
export const TOOL_IDS = {
  nestedSkill: "nested-skill",
  officeSkills: "office-skills",
  nanoFlow: "nano-flow",
} as const;

/** 侧边栏入口与主面板共用的 key。 */
export const PANEL_ID = "toolkit";

/** 侧边栏入口显示名。 */
export const PANEL_LABEL = "toolkit";
