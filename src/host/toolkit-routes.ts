import {
  TOOLKIT_NANO_FLOW_NOTES_PATH,
  TOOLKIT_NANO_FLOW_PATH,
  TOOLKIT_STATE_PATH,
  type NanoFlowNotesResponse,
  type NanoFlowSettings,
  type NanoFlowSettingsResponse,
  type NotesSnapshot,
  type ToolkitErrorBody,
  type ToolkitStateRequest,
  type ToolkitStateResponse,
} from "../contract.js";
import { UnknownToolError, type ToolkitRegistry } from "./toolkit-registry.js";
import { describeError } from "../shared/errors.js";
import { isRecord } from "../shared/record.js";

/** 宿主路由注册所需的能力。 */
interface ToolkitRoutesOptions {
  readonly registry: ToolkitRegistry;
  readonly connection: ToolkitRouteRegistry;
  /** Nano Flow 上限设置；缺省时设置路由返回 501。 */
  readonly nanoFlow?: {
    readonly get: () => NanoFlowSettings;
    readonly update: (patch: unknown) => Promise<NanoFlowSettings>;
  };
  /** Nano Flow Note 面板快照；缺省时面板路由返回 501。 */
  readonly notes?: {
    readonly of: (sessionId: string) => NotesSnapshot | null;
  };
  readonly logger: { warn(message: string): void };
}

/** `ctx.connection.fetch` 的最小形状（`dsh-api-session-controller/lib/index.js:2480-2490`）。 */
export interface ToolkitRouteRegistry {
  readonly fetch: {
    register(route: {
      path: string;
      methods: readonly string[];
      requestBody: "buffered" | "streaming";
      fetch: (request: Request) => Promise<Response>;
    }): () => void;
  };
}

/**
 * 注册工具目录、Nano Flow 设置与 note 面板路由。
 * @param options - 注册表、设置与 note 快照能力，以及连接服务。
 * @returns 注销全部路由的 disposer。
 */
export const registerToolkitRoutes = (options: ToolkitRoutesOptions): (() => void) => {
  const state = options.connection.fetch.register({
    path: TOOLKIT_STATE_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: (request) => handleState(options, request),
  });
  const nanoFlow = options.connection.fetch.register({
    path: TOOLKIT_NANO_FLOW_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: (request) => handleNanoFlow(options, request),
  });
  const notes = options.connection.fetch.register({
    path: TOOLKIT_NANO_FLOW_NOTES_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch: (request) => handleNotes(options, request),
  });
  return () => {
    state();
    nanoFlow();
    notes();
  };
};

const handleNotes = (options: ToolkitRoutesOptions, request: Request): Promise<Response> => {
  if (options.notes === undefined) {
    return Promise.resolve(
      failure(501, "unsupported-host", "nano-flow notes are not wired on this host"),
    );
  }
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (sessionId === null || sessionId === "") {
    return Promise.resolve(failure(400, "invalid-body", "missing sessionId query parameter"));
  }
  try {
    return Promise.resolve(json<NanoFlowNotesResponse>({ snapshot: options.notes.of(sessionId) }));
  } catch (error) {
    options.logger.warn(
      `toolkit: notes snapshot for "${sessionId}" failed: ${describeError(error)}`,
    );
    return Promise.resolve(failure(500, "internal", "the notes snapshot could not be read"));
  }
};

const handleNanoFlow = async (
  options: ToolkitRoutesOptions,
  request: Request,
): Promise<Response> => {
  if (options.nanoFlow === undefined) {
    return failure(501, "unsupported-host", "nano-flow settings are not wired on this host");
  }
  if (request.method === "GET") {
    return json<NanoFlowSettingsResponse>({ settings: options.nanoFlow.get() });
  }
  const parsed = await readJson(request);
  if (parsed === undefined) return failure(400, "invalid-body", "request body is not JSON");
  const patch = isRecord(parsed) ? parsed["patch"] : undefined;
  if (patch === undefined) return failure(400, "invalid-body", 'expected {"patch": {...}}');
  try {
    return json<NanoFlowSettingsResponse>({ settings: await options.nanoFlow.update(patch) });
  } catch (error) {
    return failure(400, "invalid-settings", describeError(error));
  }
};

const handleState = async (options: ToolkitRoutesOptions, request: Request): Promise<Response> => {
  if (request.method === "GET") return json<ToolkitStateResponse>(stateOf(options));
  const parsed = await readJson(request);
  if (parsed === undefined) return failure(400, "invalid-body", "request body is not JSON");
  const change = asStateRequest(parsed);
  if (change === undefined) {
    return failure(400, "invalid-body", 'expected {"id": string, "enabled": boolean}');
  }
  try {
    await options.registry.setEnabled(change.id, change.enabled);
    return json<ToolkitStateResponse>(stateOf(options));
  } catch (error) {
    if (error instanceof UnknownToolError) {
      return failure(400, "unknown-tool", error.message);
    }
    options.logger.warn(`toolkit: toggling "${change.id}" failed: ${describeError(error)}`);
    return failure(500, "internal", "the tool could not be toggled");
  }
};

const stateOf = (options: ToolkitRoutesOptions): ToolkitStateResponse => ({
  tools: options.registry.list(),
});

const json = <T>(body: T, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
};

const failure = (status: number, error: string, message: string): Response => {
  const body: ToolkitErrorBody = { error, message };
  return json(body, status);
};

const readJson = async (request: Request): Promise<unknown> => {
  try {
    const text = await request.text();
    if (text.trim() === "") return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** 外部输入按字段逐项校验：不接受多余形状的猜测。 */
const asStateRequest = (value: unknown): ToolkitStateRequest | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { id?: unknown; enabled?: unknown };
  if (typeof record.id !== "string" || record.id === "") return undefined;
  if (typeof record.enabled !== "boolean") return undefined;
  return { id: record.id, enabled: record.enabled };
};
