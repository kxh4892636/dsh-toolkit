import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import type Schema from "@deepseek-ai/schemastery";
import type { NanoFlowSettings, NotesSnapshot } from "./contract.js";
import { createNanoFlowSettingsStore, nodeNanoFlowSettingsIo } from "./host/nano-flow-settings.js";
import { NANO_FLOW_SERVICE, type ToolkitNanoFlowFacade } from "./host/nano-flow-facade.js";
import { createNanoFlowTool } from "./host/tools/nano-flow.js";
import { applyCompactionBridge, applyNanoFlow } from "./nano-flow/assembly/plugin.js";
import { recordMount, restoreMountReport } from "./nano-flow/session/mount-report.js";
import { buildNotesSnapshot } from "./nano-flow/planning/notes.js";
import { NANO_FLOW_PRESET_ID, nanoFlowEntryUrl } from "./nano-flow/assembly/preset.js";
import {
  createRotation,
  type RotationSession,
  type WaitForTurnEnd,
} from "./nano-flow/session/rotate.js";
import { createPlanLogService } from "./nano-flow/planning/plan-log-service.js";
import {
  BINDINGS_FILE,
  planRelativePath,
  pruneBindings,
  readBindings,
  readBindingsSync,
  resolvePlanDirectory,
  writeBindings,
} from "./nano-flow/planning/plan-log.js";
import { resolveWorkspace } from "./nano-flow/session/workspace.js";
import { hostServices } from "./nano-flow/session/services.js";
import { createNestedSkillTool } from "./host/tools/nested-skill.js";
import { createOfficeSkillsTool } from "./host/tools/office-skills.js";
import { registerToolkitRoutes, type ToolkitRouteRegistry } from "./host/toolkit-routes.js";
import { ToolkitRegistry } from "./host/toolkit-registry.js";
import { nodeToolkitStateIo, ToolkitStateStore } from "./host/toolkit-state.js";
import {
  hasMethod,
  serviceOf,
  type HostSessionPersistence,
  type HostSessionStore,
} from "./host/services.js";
import { DEFAULT_EXCLUDED_DIRS, type NestedSkillOptions } from "./nested-skill/provider.js";

export { NESTED_SKILL_RANKS, nestedRank, PROVIDER_NAME } from "./nested-skill/provider.js";
export type { NestedSkillSource } from "./nested-skill/provider.js";
export { TOOL_IDS } from "./contract.js";
import { describeError } from "./shared/errors.js";

/** 插件配置：嵌套 skill 工具的选项 + 状态文件位置覆盖。 */
export type Config = NestedSkillOptions & {
  /** 工具状态文件；缺省 `$DSH_HOME/toolkit/state.json`。 */
  stateFile?: string;
  /** Nano Flow 上限设置文件；缺省 `$DSH_HOME/toolkit/nano-flow.json`。 */
  nanoFlowFile?: string;
  /** 会话↔Plan 绑定表；缺省 `$DSH_HOME/toolkit/nano-flow-plan-bindings.json`。 */
  bindingsFile?: string;
  /** Nano Flow 的工作区覆盖（预设行可传）。 */
  workspace?: string;
  /** Nano Flow 的领域根覆盖（预设行可传）。 */
  domainRoot?: string;
  /** 内部：为 true 时只挂载 Nano Flow 预设内的那一半（由预设行传入）。 */
  nanoFlowOnly?: boolean;
  /** 内部：为 true 时只把该 realm 的压缩引擎登记进模块级桥（由压缩 group 内的那一行传入）。 */
  compactBridgeOnly?: boolean;
};

export const Config: Schema<Config> = z.object({
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchPollIntervalMs: z.number().default(100),
  watchStabilityThresholdMs: z.number().default(200),
  includeUserRoots: z.boolean().default(true),
  agentsHome: z.string(),
  excludedDirs: z.array(z.string()).default(DEFAULT_EXCLUDED_DIRS),
  extraRoots: z.array(z.string()).default([]),
  stateFile: z.string(),
  nanoFlowFile: z.string(),
  bindingsFile: z.string(),
  workspace: z.string(),
  domainRoot: z.string(),
  nanoFlowOnly: z.boolean(),
  compactBridgeOnly: z.boolean(),
});

/** 写入或切换会话↔Plan 绑定；显式绑定工具用，覆盖旧值。 */
const replaceBinding = async (
  file: string,
  sessionId: string,
  planDirectory: string,
  workspace: string,
): Promise<void> => {
  const table = await readBindings(file);
  table[sessionId] = {
    planPath: planRelativePath(workspace, planDirectory),
    cwd: workspace,
    boundAt: new Date().toISOString(),
  };
  await writeBindings(file, table);
};

/**
 * 清掉绑定表里的死条目：宿主已不存在的会话不再占位。
 *
 * 宿主不提供会话列表、列举失败或列表为空时跳过——宁可留着旧条目，也不清空整张表。
 * @param ctx - 用于取 `sessionPersistence`。
 * @param file - 绑定表路径。
 * @param logger - 告警出口。
 */
const pruneDeadBindings = async (
  ctx: Context,
  file: string,
  logger: { warn(message: string): void },
): Promise<void> => {
  const persistence = serviceOf<HostSessionPersistence>(ctx, "sessionPersistence");
  if (!hasMethod<HostSessionPersistence>(persistence, "list")) return;
  let stored: readonly string[];
  try {
    stored = (await persistence.list()).map((snapshot) => snapshot.header.id);
  } catch (error) {
    logger.warn(`toolkit: listing sessions for binding cleanup failed: ${describeError(error)}`);
    return;
  }
  const table = await readBindings(file);
  const alive = new Set(stored);
  // 持久化只覆盖「有日志的会话」：仍存活但还没落盘日志的会话也算，别把它的绑定删掉。
  const sessions = serviceOf<HostSessionStore>(ctx, "sessions");
  try {
    for (const sessionId of Object.keys(table)) {
      if (alive.has(sessionId)) continue;
      if (hasMethod<HostSessionStore>(sessions, "get") && sessions.get(sessionId) !== undefined) {
        alive.add(sessionId);
      }
    }
  } catch (error) {
    logger.warn(
      `toolkit: checking live sessions for binding cleanup failed: ${describeError(error)}`,
    );
    return;
  }
  if (alive.size === 0) return;
  const pruned = pruneBindings(table, alive);
  if (Object.keys(pruned).length === Object.keys(table).length) return;
  await writeBindings(file, pruned);
};

/** 会话↔Plan 绑定表路径：配置优先，缺省落在 `$DSH_HOME/toolkit`。 */
const bindingsFilePath = (config: Config): string =>
  config.bindingsFile !== undefined && config.bindingsFile !== ""
    ? config.bindingsFile
    : join(resolveDshHome(), "toolkit", BINDINGS_FILE);

export const name = "toolkit";
export const inject = ["skills"];

/**
 * 挂载工具集：注册路由并按持久状态启停工具。
 * @param ctx - 插件所在 cordis 上下文。
 * @param config - 插件配置；全部字段可选。
 */
export const apply = (ctx: Context, config: Config = {}): void => {
  recordMount("entry", {
    nanoFlowOnly: config.nanoFlowOnly === true,
    compactBridgeOnly: config.compactBridgeOnly === true,
    via: config.nanoFlowOnly === true || config.compactBridgeOnly === true ? "preset" : "root",
  });
  // 只挂压缩桥的那一行（压缩 group 内）：先把该 realm 的引擎登记进模块级槽，别的都不做。
  if (config.compactBridgeOnly === true) {
    applyCompactionBridge(ctx, config);
    return;
  }
  if (config.nanoFlowOnly === true) {
    applyNanoFlow(ctx, config);
    return;
  }
  // Plan 轨迹日志先建：runtime 删除会话时要靠它关掉该会话的读句柄。
  const planLog = createPlanLogService({
    home: resolveDshHome(),
    bindingsFile: bindingsFilePath(config),
    logger: ctx.logger,
  });
  ctx.effect(() => () => void planLog.dispose(), "toolkit: plan log");
  const runtime = createRuntime(ctx, config);
  ctx.effect(() => () => void runtime.dispose(), "toolkit: runtime");
  restoreMountReport();
  ctx.inject(["connection"], (child: Context) => {
    const connection = serviceOf<ToolkitRouteRegistry>(child, "connection");
    if (!hasRouteRegistry(connection)) return;
    const disposeRoutes = registerToolkitRoutes({
      registry: runtime.registry,
      connection,
      logger: ctx.logger,
      nanoFlow: {
        get: () => runtime.nanoFlow.get(),
        update: (patch: unknown) => runtime.nanoFlow.update(patch),
      },
      notes: {
        of: (sessionId: string) => runtime.notesOf(sessionId),
      },
    });
    child.effect(() => disposeRoutes, "toolkit: routes");
  });
  // 上下文轮转挂在宿主层：预设行看不到 `ctx.agent`（cordis 的 inject 守卫），只能由这里按
  // 会话日志里的预设选择判定，再包装 `sessionController.prompt`。触发时先注入一轮把检查点
  // 写回磁盘，再让预设作用域里的压缩引擎摘要旧历史，然后注入一轮读回并校验，最后放行用户的
  // 消息；压缩在会话内完成，因此子 agent、后台 job 与 Plan 绑定原样存活。
  ctx.inject(["sessionController"], (child: Context) => {
    child.effect(() => {
      /**
       * 等某会话的下一个 `turn/end`。
       *
       * 插件注入的那一轮走的是真实 `prompt`：准入即返回（只入 inbox），所以「这一轮跑完了」
       * 只能由会话事件判定，宿主没有提供「某条消息跑完」的 promise。超时与取消都以 reject
       * 表达，由轮转方按失败处理（只 warn，不阻断用户消息）。
       */
      const waitForTurnEnd: WaitForTurnEnd = ({ sessionId, signal, afterTurn, timeoutMs }) =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let unsubscribe: () => void = () => {};
          const finish = (error?: unknown): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            unsubscribe();
            if (error === undefined) resolve();
            else reject(error);
          };
          function onAbort(): void {
            finish(signal.reason ?? new Error("rotation wait aborted"));
          }
          timer = setTimeout(
            () => finish(new Error(`no turn/end within ${timeoutMs} ms`)),
            timeoutMs,
          );
          unsubscribe = child.on(
            "session/event",
            (session: unknown, event: unknown) => {
              if ((session as { id?: unknown } | null)?.id !== sessionId) return;
              if ((event as { type?: unknown } | null)?.type !== "turn/end") return;
              // 只认注入之后那一轮：更早的轮次结束时开跑压缩会撞上 busy。
              const turn = (event as { data?: { turn?: unknown } } | null)?.data?.turn;
              if (afterTurn !== undefined && typeof turn === "number" && turn <= afterTurn) return;
              finish();
            },
            { global: true },
          ) as () => void;
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });

      const rotation = createRotation({
        services: hostServices(child),
        config: { presetId: NANO_FLOW_PRESET_ID },
        settings: () => runtime.nanoFlow.get(),
        waitForTurnEnd,
        sessionOf: (sessionId: string) => {
          const sessions = serviceOf<HostSessionStore>(child, "sessions");
          const session = sessions?.get(sessionId);
          return session as unknown as RotationSession | undefined;
        },
      });
      const disposeRotation = rotation.attach();
      recordMount("rotation", {
        tokenMeter: serviceOf<object>(child, "tokenMeter") !== undefined,
        agents: serviceOf<object>(child, "agents") !== undefined,
        sessionController: serviceOf<object>(child, "sessionController") !== undefined,
        waitForTurnEnd: true,
      });
      return disposeRotation;
    }, "toolkit: nano-flow rotation");
  });
  // 订阅会话事件 firehose（seed 不触发），按轮把 compact 摘要追加到 Plan 的 log.jsonl。
  ctx.inject(["sessionPersistence"], (child: Context) => {
    const persistence = serviceOf<{ open(id: string, mode: "read"): Promise<unknown> }>(
      child,
      "sessionPersistence",
    );
    if (persistence === undefined || typeof persistence.open !== "function") return;
    planLog.attach(persistence as never);
    const dispose = child.on(
      "session/event",
      (session: unknown, event: unknown) => {
        planLog.onEvent(session, event);
      },
      { global: true },
    );
    child.effect(() => dispose as () => void, "toolkit: plan log subscription");
  });
  void runtime.start();
};

/** 运行期：状态存储、工具注册表与宿主服务的懒查找。 */
interface ToolkitRuntime {
  readonly registry: ToolkitRegistry;
  start(): Promise<void>;
  /** 写入或切换会话↔Plan 绑定（只有 nano_flow_bind 调用）。 */
  rebindSession(sessionId: string, planDirectory: string, workspace: string): Promise<void>;
  /** Nano Flow 上限设置（面板路由读写）。 */
  readonly nanoFlow: {
    get(): NanoFlowSettings;
    update(patch: unknown): Promise<NanoFlowSettings>;
  };
  /** 当前会话要展示的未完成 note 快照；不写会话日志。 */
  notesOf(sessionId: string): NotesSnapshot | null;
  dispose(): Promise<void>;
}

const createRuntime = (ctx: Context, config: Config): ToolkitRuntime => {
  const logger = ctx.logger;
  const home = resolveDshHome();
  const store = new ToolkitStateStore(
    nodeToolkitStateIo(config.stateFile ?? join(home, "toolkit", "state.json")),
  );
  const settings = createNanoFlowSettingsStore(
    nodeNanoFlowSettingsIo(config.nanoFlowFile ?? join(home, "toolkit", "nano-flow.json")),
    logger,
  );
  const tools = [
    createNestedSkillTool(nestedOptions(config)),
    createOfficeSkillsTool(),
    createNanoFlowTool({ entryUrl: nanoFlowEntryUrl(import.meta.url) }),
  ];
  const registry = new ToolkitRegistry({ ctx, tools, store, logger });
  /**
   * 写入或切换绑定：`nano_flow_bind` 的唯一落点。
   *
   * 顺带回收死条目。绑定表按 `$DSH_HOME` 共享，因此「存活」以各实例自己的
   * 持久化列表为准：同一 DSH_HOME 上跑多个宿主时，列表只覆盖本实例见过的会话。
   */
  const rebindSession = async (
    sessionId: string,
    planDirectory: string,
    workspace: string,
  ): Promise<void> => {
    await pruneDeadBindings(ctx, bindingsFilePath(config), logger).catch((error: unknown) => {
      logger.warn(`toolkit: pruning bindings failed: ${describeError(error)}`);
    });
    await replaceBinding(bindingsFilePath(config), sessionId, planDirectory, workspace);
  };
  const nanoFlow: ToolkitNanoFlowFacade = {
    settings: () => settings.current(),
    updateSettings: (patch: unknown) => settings.update(patch),
    rebindSession,
  };
  ctx.effect(() => {
    try {
      const disposer = (
        ctx as unknown as { provide?: (name: string, value: unknown) => unknown }
      ).provide?.(NANO_FLOW_SERVICE, nanoFlow);
      return typeof disposer === "function"
        ? () => {
            void (disposer as () => unknown)();
          }
        : () => {};
    } catch (error) {
      logger.warn(`toolkit: providing ${NANO_FLOW_SERVICE} failed: ${describeError(error)}`);
      return () => {};
    }
  }, "toolkit: nano-flow service");

  return {
    registry,
    nanoFlow: {
      get: () => settings.current(),
      update: (patch: unknown) => settings.update(patch),
    },
    async start() {
      try {
        await settings.load();
        await registry.initialize();
      } catch (error) {
        logger.warn(`toolkit: start failed: ${describeError(error)}`);
      }
    },
    rebindSession,
    async dispose() {
      await registry.dispose();
    },
    notesOf(sessionId) {
      const sessions = serviceOf<HostSessionStore>(ctx, "sessions");
      if (!hasMethod<HostSessionStore>(sessions, "get")) return null;
      const session = sessions.get(sessionId);
      const workspace = resolveWorkspace({
        configured: config.workspace,
        sessionCwd: session?.header?.cwd,
      });
      if (workspace === undefined) return null;
      // 面板只对已绑定 Plan 的会话显示；绑定由 nano_flow 工具执行时写入。
      const binding = readBindingsSync(bindingsFilePath(config))[sessionId];
      if (binding === undefined) return null;
      // 绑定时的 cwd 可能已失效（换机器、迁移目录）：解析不到就算了，别指向不存在的目录。
      const planDirectory = resolvePlanDirectory(binding, workspace);
      if (!existsSync(planDirectory)) return null;
      try {
        return buildNotesSnapshot(workspace, planDirectory);
      } catch (error) {
        logger.warn(`toolkit: notes snapshot failed: ${describeError(error)}`);
        return null;
      }
    },
  };
};

/** `ctx.connection.fetch` 是对象而不是函数，因此单独判断其 `register` 成员。 */
const hasRouteRegistry = (service: unknown): service is ToolkitRouteRegistry => {
  if (typeof service !== "object" || service === null) return false;
  const fetch = (service as { fetch?: unknown }).fetch;
  if (typeof fetch !== "object" || fetch === null) return false;
  return typeof (fetch as { register?: unknown }).register === "function";
};

/** 只把嵌套 skill 工具认识的字段传下去，避免工具集选项被当成 provider 选项。 */
const nestedOptions = (config: Config): NestedSkillOptions => {
  const options: NestedSkillOptions = {};
  if (config.watch !== undefined) options.watch = config.watch;
  if (config.watchUsePolling !== undefined) options.watchUsePolling = config.watchUsePolling;
  if (config.watchPollIntervalMs !== undefined) {
    options.watchPollIntervalMs = config.watchPollIntervalMs;
  }
  if (config.watchStabilityThresholdMs !== undefined) {
    options.watchStabilityThresholdMs = config.watchStabilityThresholdMs;
  }
  if (config.includeUserRoots !== undefined) options.includeUserRoots = config.includeUserRoots;
  if (config.agentsHome !== undefined) options.agentsHome = config.agentsHome;
  if (config.excludedDirs !== undefined) options.excludedDirs = config.excludedDirs;
  if (config.extraRoots !== undefined) options.extraRoots = config.extraRoots;
  return options;
};
