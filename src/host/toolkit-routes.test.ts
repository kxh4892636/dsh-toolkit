import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_NANO_FLOW_SETTINGS,
  TOOLKIT_NANO_FLOW_NOTES_PATH,
  TOOLKIT_NANO_FLOW_PATH,
  TOOLKIT_STATE_PATH,
  type NotesSnapshot,
} from "../contract.js";
import { createNanoFlowSettingsStore, type NanoFlowSettingsIo } from "./nano-flow-settings.js";
import { registerToolkitRoutes, type ToolkitRouteRegistry } from "./toolkit-routes.js";
import { ToolkitRegistry } from "./toolkit-registry.js";
import { ToolkitStateStore, type ToolkitStateIo } from "./toolkit-state.js";

const memoryIo = (): ToolkitStateIo => {
  let text: string | undefined;
  return {
    async read() {
      return text;
    },
    async write(next) {
      text = next;
    },
  };
};

const memorySettingsIo = (): NanoFlowSettingsIo => {
  let text: string | undefined;
  return {
    async read() {
      return text;
    },
    async write(next) {
      text = next;
    },
  };
};

const setup = async () => {
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const connection: ToolkitRouteRegistry = {
    fetch: {
      register: (route) => {
        routes.set(route.path, route.fetch);
        return () => routes.delete(route.path);
      },
    },
  };
  const store = new ToolkitStateStore(memoryIo());
  const registry = new ToolkitRegistry({
    ctx: {} as never,
    tools: [
      {
        id: "nested-skill",
        title: "嵌套 skill 发现",
        description: "desc",
        defaultEnabled: true,
        apply: () => () => {},
      },
    ],
    store,
    logger: { warn: vi.fn() },
  });
  await registry.initialize();
  const settings = createNanoFlowSettingsStore(memorySettingsIo(), { warn: vi.fn() });
  await settings.load();
  const notesSnapshot: NotesSnapshot = {
    planName: "2026-11-08-演示",
    planPath: ".agents/domains/dsh/plans/active/2026-11-08-演示",
    notes: [{ name: "001-第一个", status: "pending", description: "概述" }],
  };
  const notes = {
    of: vi.fn((sessionId: string) => (sessionId === "session-1" ? notesSnapshot : null)),
  };
  const dispose = registerToolkitRoutes({
    registry,
    connection,
    nanoFlow: {
      get: () => settings.current(),
      update: (patch: unknown) => settings.update(patch),
    },
    notes,
    logger: { warn: vi.fn() },
  });
  const call = (path: string, request: Request): Promise<Response> => {
    const handler = routes.get(path);
    if (handler === undefined) throw new Error(`route ${path} not registered`);
    return handler(request);
  };
  return { call, registry, settings, notes, dispose, routes };
};

const request = (
  path: string,
  init: { method?: string; body?: unknown; url?: string } = {},
): Request => {
  const url = init.url ?? `http://127.0.0.1:58683${path}`;
  const method = init.method ?? "GET";
  if (init.body === undefined) return new Request(url, { method });
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
};

describe("toolkit routes", () => {
  it("returns the tool catalog", async () => {
    const { call } = await setup();
    const response = await call(TOOLKIT_STATE_PATH, request(TOOLKIT_STATE_PATH));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: { id: string; enabled: boolean }[] };
    expect(body.tools.map((tool) => `${tool.id}:${tool.enabled}`)).toEqual(["nested-skill:true"]);
  });

  it("toggles a tool and reflects it in the catalog", async () => {
    const { call, registry } = await setup();
    const response = await call(
      TOOLKIT_STATE_PATH,
      request(TOOLKIT_STATE_PATH, {
        method: "POST",
        body: { id: "nested-skill", enabled: false },
      }),
    );
    expect(response.status).toBe(200);
    expect(registry.isEnabled("nested-skill")).toBe(false);
  });

  it("rejects malformed toggle bodies and unknown tools", async () => {
    const { call } = await setup();
    const broken = await call(
      TOOLKIT_STATE_PATH,
      request(TOOLKIT_STATE_PATH, { method: "POST", body: "{oops" }),
    );
    expect(broken.status).toBe(400);
    const missing = await call(
      TOOLKIT_STATE_PATH,
      request(TOOLKIT_STATE_PATH, { method: "POST", body: { id: "a" } }),
    );
    expect(missing.status).toBe(400);
    const unknown = await call(
      TOOLKIT_STATE_PATH,
      request(TOOLKIT_STATE_PATH, { method: "POST", body: { id: "nope", enabled: true } }),
    );
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: "unknown-tool" });
  });

  it("returns the nano-flow notes snapshot for a session", async () => {
    const { call, notes } = await setup();
    const response = await call(
      TOOLKIT_NANO_FLOW_NOTES_PATH,
      request(TOOLKIT_NANO_FLOW_NOTES_PATH, {
        url: `http://127.0.0.1:58683${TOOLKIT_NANO_FLOW_NOTES_PATH}?sessionId=session-1`,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      snapshot: { planName: "2026-11-08-演示", notes: [{ name: "001-第一个" }] },
    });
    expect(notes.of).toHaveBeenCalledWith("session-1");
  });

  it("returns a null snapshot when the session has no active plan", async () => {
    const { call } = await setup();
    const response = await call(
      TOOLKIT_NANO_FLOW_NOTES_PATH,
      request(TOOLKIT_NANO_FLOW_NOTES_PATH, {
        url: `http://127.0.0.1:58683${TOOLKIT_NANO_FLOW_NOTES_PATH}?sessionId=session-2`,
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ snapshot: null });
  });

  it("rejects a notes request without a session id", async () => {
    const { call } = await setup();
    const response = await call(
      TOOLKIT_NANO_FLOW_NOTES_PATH,
      request(TOOLKIT_NANO_FLOW_NOTES_PATH),
    );
    expect(response.status).toBe(400);
  });

  it("reports a failing notes snapshot as an internal error", async () => {
    const { call, notes } = await setup();
    notes.of.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const response = await call(
      TOOLKIT_NANO_FLOW_NOTES_PATH,
      request(TOOLKIT_NANO_FLOW_NOTES_PATH, {
        url: `http://127.0.0.1:58683${TOOLKIT_NANO_FLOW_NOTES_PATH}?sessionId=session-1`,
      }),
    );
    expect(response.status).toBe(500);
  });

  it("unregisters all routes on dispose", async () => {
    const { dispose, routes } = await setup();
    expect(routes.size).toBe(3);
    dispose();
    expect(routes.size).toBe(0);
  });
  it("reads and saves nano-flow settings", async () => {
    const { call } = await setup();
    const read = await call(TOOLKIT_NANO_FLOW_PATH, request(TOOLKIT_NANO_FLOW_PATH));
    expect(read.status).toBe(200);
    const initial = (await read.json()) as { settings: { specMaxBytes: number } };
    expect(initial.settings.specMaxBytes).toBe(DEFAULT_NANO_FLOW_SETTINGS.specMaxBytes);

    const saved = await call(
      TOOLKIT_NANO_FLOW_PATH,
      request(TOOLKIT_NANO_FLOW_PATH, { method: "POST", body: { patch: { noteMaxBytes: 2048 } } }),
    );
    expect(saved.status).toBe(200);
    const next = (await saved.json()) as { settings: { noteMaxBytes: number } };
    expect(next.settings.noteMaxBytes).toBe(2048);

    const rejected = await call(
      TOOLKIT_NANO_FLOW_PATH,
      request(TOOLKIT_NANO_FLOW_PATH, { method: "POST", body: { patch: { noteMaxBytes: -1 } } }),
    );
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toBe("invalid-settings");
  });
});
