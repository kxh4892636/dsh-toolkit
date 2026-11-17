import { describe, expect, it, vi } from "vite-plus/test";
import type { UndoSessionEvent } from "./turn-boundary.js";
import {
  inspectUndo,
  UndoUnavailableError,
  undoTurn,
  type UndoDeps,
  type UndoQueueController,
  type UndoSession,
} from "./undo-turn.js";

/** 表面事件类型：真实日志里这些事件都带 `surfaceOp`。 */
const SURFACE_TYPES = new Set([
  "system/message",
  "developer/message",
  "user/message",
  "assistant/message",
  "tool/result",
]);

const events = (spec: readonly [string, unknown?][]): UndoSessionEvent[] =>
  spec.map(([type, data], seq) => ({
    type,
    seq,
    ...(data === undefined ? {} : { data }),
    ...(SURFACE_TYPES.has(type) ? { surfaceOp: "append" } : {}),
  }));

const userMessage = (text: string, id?: string): unknown => ({
  ...(id === undefined ? {} : { id }),
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: "user" },
});

const assistantMessage = (text: string): unknown => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
});

/** 两轮会话：最后一条是第二轮的用户消息（seq 4）。 */
const twoTurns = (): UndoSessionEvent[] =>
  events([
    ["turn/start", { turn: 1 }],
    ["user/message", userMessage("一", "m1")],
    ["turn/end", { turn: 1 }],
    ["turn/start", { turn: 2 }],
    ["user/message", userMessage("二", "m2")],
  ]);

/** 事件序列上的表面折叠：只够撤回用（追加进尾部，替换换掉整段）。 */
const foldNodes = (log: readonly UndoSessionEvent[]): number[] => {
  const nodes: number[] = [];
  for (const event of log) {
    const op = event.surfaceOp;
    if (op === "append") {
      nodes.push(event.seq);
      continue;
    }
    if (typeof op !== "object" || op === null) continue;
    const { startSeq, endSeq } = op as { startSeq: number; endSeq: number };
    const start = nodes.indexOf(startSeq);
    const end = nodes.indexOf(endSeq);
    if (start < 0 || end < start) continue;
    nodes.splice(start, end - start + 1, event.seq);
  }
  return nodes;
};

interface Appended {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly opts: { readonly surfaceOp?: unknown; readonly sourceEventSeqs?: readonly number[] };
}

/** 会话替身：`append` 真写进日志，好让断言看到落地的墓碑。 */
const makeSession = (
  log: readonly UndoSessionEvent[],
  surface?: readonly number[],
): UndoSession & { appended: Appended[]; log: UndoSessionEvent[] } => {
  const mutable = [...log];
  const appended: Appended[] = [];
  return {
    log: mutable,
    appended,
    get seq() {
      return mutable.length;
    },
    surface: { nodes: [...(surface ?? foldNodes(mutable))] },
    snapshotEvents: () => mutable,
    append(type: string, data: unknown, opts?: unknown) {
      const seq = mutable.length;
      const written = (opts ?? {}) as Appended["opts"];
      appended.push({ type, data: data as Record<string, unknown>, opts: written });
      mutable.push({ type, seq, data, surfaceOp: written.surfaceOp });
      return { seq };
    },
  };
};

interface SetupOptions {
  readonly log?: readonly UndoSessionEvent[];
  readonly surface?: readonly number[];
  /** 会话是否存活；false 时 `get` 始终返回 undefined。 */
  readonly live?: boolean;
  /** agent 运行状态；`running` 时撤回应当拒绝。 */
  readonly status?: string;
  /** 宿主是否暴露 agents 服务。 */
  readonly agents?: false;
  /** 宿主是否暴露队列能力。 */
  readonly queue?: false;
  /** 队列里的待发输入 id。 */
  readonly queued?: readonly string[];
  /** 让 `state()` 抛错。 */
  readonly queueReadFails?: boolean;
  /** 让第 n 条移除抛错（1 起）。 */
  readonly queueRemoveFailsAt?: number;
  /** 宿主不提供 `sessions.flush`。 */
  readonly flush?: false;
  /** 让 `flush` 抛错。 */
  readonly flushFails?: boolean;
}

const setup = (options: SetupOptions = {}) => {
  const session = makeSession(options.log ?? twoTurns(), options.surface);
  const flush = options.flushFails
    ? vi.fn(async () => {
        throw new Error("flush failed");
      })
    : vi.fn(async () => true);
  const sessions: NonNullable<UndoDeps["sessions"]> = {
    get: () => (options.live === false ? undefined : session),
    ...(options.flush === false ? {} : { flush }),
  };
  const removed: { readonly itemId: string; readonly action: unknown }[] = [];
  const queueRead = vi.fn(async () => ({ queue: (options.queued ?? []).map((id) => ({ id })) }));
  const remove = vi.fn(async (request: { readonly itemId: string; readonly action: unknown }) => {
    removed.push({ itemId: request.itemId, action: request.action });
    if (options.queueRemoveFailsAt === removed.length) throw new Error("remove failed");
    return { accepted: true };
  });
  const controller: UndoQueueController = {
    state: options.queueReadFails
      ? vi.fn(async () => {
          throw new Error("state failed");
        })
      : queueRead,
    updateQueue: remove,
  };
  const warn = vi.fn();
  const deps: UndoDeps = {
    sessions,
    logger: { warn },
    ...(options.queue === false ? {} : { controller }),
    ...(options.agents === false
      ? {}
      : {
          agents: {
            get: () => (options.status === undefined ? {} : { status: options.status }),
          },
        }),
  };
  return { deps, session, sessions, flush, remove, queueRead, removed, warn };
};

describe("inspectUndo", () => {
  it("reports the prompt of the last turn", () => {
    const { deps } = setup();
    expect(inspectUndo(deps, "session-source")).toEqual({ available: true, prompt: "二" });
  });

  it("reports a session that is not live", () => {
    const { deps } = setup({ live: false });
    expect(inspectUndo(deps, "session-gone")).toEqual({
      available: false,
      reason: "session-not-live",
    });
  });

  it("reports a session whose agent is running", () => {
    const { deps } = setup({ status: "running" });
    expect(inspectUndo(deps, "session-1")).toEqual({ available: false, reason: "agent-busy" });
  });

  it("reports a session with a single turn", () => {
    const { deps } = setup({ log: twoTurns().slice(0, 3) });
    expect(inspectUndo(deps, "session-1")).toEqual({
      available: false,
      reason: "no-previous-turn",
    });
  });

  it("reports a session that exposes no writable surface", () => {
    const { deps } = setup();
    const readOnly = { snapshotEvents: () => twoTurns() };
    expect(inspectUndo({ ...deps, sessions: { get: () => readOnly } }, "x")).toEqual({
      available: false,
      reason: "unsupported-host",
    });
  });
});

describe("undoTurn", () => {
  it("appends one tombstone and returns the recall boundary", async () => {
    const { deps, session } = setup();
    const result = await undoTurn(deps, "session-source");
    // 会话 id 不变：返回值里只剩切点、墓碑 seq 与原文。
    expect(result).toEqual({ boundary: 4, seq: 5, prompt: "二" });
    expect(session.appended).toHaveLength(1);
    const [tombstone] = session.appended;
    expect(tombstone?.type).toBe("system/message");
    expect(tombstone?.data).toMatchObject({
      turn: 2,
      step: 1,
      recall: { boundary: 4, end: 4 },
      message: {
        id: "recall-5-4",
        role: "system",
        source: { kind: "system-prompt" },
        content: [],
      },
    });
    expect(tombstone?.opts).toEqual({
      surfaceOp: { op: "replace", startSeq: 4, endSeq: 4 },
      sourceEventSeqs: [4],
    });
  });

  it("shadows every surface node from the boundary to the tail", async () => {
    const log = events([
      ["turn/start", { turn: 1 }],
      ["user/message", userMessage("一", "m1")],
      ["assistant/message", assistantMessage("一答")],
      ["turn/end", { turn: 1 }],
      ["turn/start", { turn: 2 }],
      ["user/message", userMessage("二", "m2")],
      ["assistant/message", assistantMessage("二答")],
      ["tool/result", { message: { id: "t1", content: [] } }],
    ]);
    const { deps, session } = setup({ log });
    const result = await undoTurn(deps, "session-source");
    expect(result.boundary).toBe(5);
    expect(session.appended[0]?.opts).toEqual({
      surfaceOp: { op: "replace", startSeq: 5, endSeq: 7 },
      sourceEventSeqs: [5, 6, 7],
    });
    expect(session.appended[0]?.data["recall"]).toEqual({ boundary: 5, end: 7 });
  });

  it("flushes the session once after writing the tombstone", async () => {
    const { deps, flush, session } = setup();
    await undoTurn(deps, "session-source");
    expect(flush).toHaveBeenCalledWith(session);
  });

  it("keeps the recall when the store exposes no flush", async () => {
    const { deps, warn, session } = setup({ flush: false });
    await expect(undoTurn(deps, "session-source")).resolves.toMatchObject({ boundary: 4 });
    expect(session.appended).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no flush"));
  });

  it("keeps the recall when the flush fails", async () => {
    const { deps, warn } = setup({ flushFails: true });
    await expect(undoTurn(deps, "session-source")).resolves.toMatchObject({ boundary: 4 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("flushing the recall mark failed"));
  });

  it("clears queued input one item at a time", async () => {
    const { deps, removed, queueRead } = setup({ queued: ["q1", "q2"] });
    await undoTurn(deps, "session-source");
    expect(queueRead).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([
      { itemId: "q1", action: { kind: "remove" } },
      { itemId: "q2", action: { kind: "remove" } },
    ]);
  });

  it("keeps going when the host exposes no queue", async () => {
    const { deps, warn } = setup({ queue: false });
    await expect(undoTurn(deps, "session-source")).resolves.toMatchObject({ prompt: "二" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no session queue"));
  });

  it("keeps going when reading the queue fails", async () => {
    const { deps, warn, remove } = setup({ queueReadFails: true });
    await expect(undoTurn(deps, "session-source")).resolves.toMatchObject({ boundary: 4 });
    expect(remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reading the queue"));
  });

  it("keeps going when one queued item cannot be removed", async () => {
    const { deps, removed, warn } = setup({ queued: ["q1", "q2"], queueRemoveFailsAt: 1 });
    await expect(undoTurn(deps, "session-source")).resolves.toMatchObject({ boundary: 4 });
    // 逐条尝试：第一条失败不影响第二条。
    expect(removed.map((item) => item.itemId)).toEqual(["q1", "q2"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('removing queued input "q1"'));
  });

  it("throws a reason when the session is not live", async () => {
    const { deps } = setup({ live: false });
    const failure = undoTurn(deps, "session-gone");
    await expect(failure).rejects.toBeInstanceOf(UndoUnavailableError);
    await expect(failure).rejects.toMatchObject({ reason: "session-not-live" });
  });

  it("throws a reason when there is no earlier turn", async () => {
    const { deps } = setup({ log: twoTurns().slice(0, 3) });
    await expect(undoTurn(deps, "session-1")).rejects.toMatchObject({ reason: "no-previous-turn" });
  });

  it("refuses to rewrite a surface while the agent is running", async () => {
    const { deps, session, queueRead } = setup({ status: "running" });
    await expect(undoTurn(deps, "session-1")).rejects.toMatchObject({ reason: "agent-busy" });
    expect(session.appended).toHaveLength(0);
    expect(queueRead).not.toHaveBeenCalled();
  });

  it("still undoes when the host exposes no agents service", async () => {
    const { deps, session } = setup({ agents: false });
    await expect(undoTurn(deps, "session-source")).resolves.toMatchObject({ boundary: 4 });
    expect(session.appended).toHaveLength(1);
  });

  it("rejects a boundary that already left the surface", async () => {
    // 表面只剩上一轮：第二轮的用户消息早先被替换掉了。
    const { deps, session } = setup({ surface: [1, 2] });
    await expect(undoTurn(deps, "session-source")).rejects.toMatchObject({
      reason: "no-previous-turn",
    });
    expect(session.appended).toHaveLength(0);
  });

  it("does not touch the queue when the turn cannot be undone", async () => {
    const { deps, queueRead } = setup({ log: twoTurns().slice(0, 3) });
    await expect(undoTurn(deps, "session-1")).rejects.toBeInstanceOf(UndoUnavailableError);
    expect(queueRead).not.toHaveBeenCalled();
  });

  it("accepts an anchor naming the last turn's user message", async () => {
    const { deps } = setup();
    await expect(
      undoTurn(deps, "session-source", { messageId: "m2", boundary: 4 }),
    ).resolves.toMatchObject({ boundary: 4 });
  });

  it("rejects an anchor that names another boundary", async () => {
    const { deps, session } = setup();
    await expect(undoTurn(deps, "session-source", { boundary: 1 })).rejects.toMatchObject({
      reason: "no-previous-turn",
    });
    expect(session.appended).toHaveLength(0);
  });

  it("rejects an anchor naming another message", async () => {
    const { deps } = setup();
    await expect(undoTurn(deps, "session-source", { messageId: "m1" })).rejects.toMatchObject({
      reason: "no-previous-turn",
    });
  });
});
