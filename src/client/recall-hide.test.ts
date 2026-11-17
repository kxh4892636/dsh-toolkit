// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  ClientContext,
  ClientSlotEntry,
  ClientSlotOptions,
  ConversationDefinitionLike,
  ConversationEventsLike,
  ConversationViewNodeLike,
} from "./contract.js";
import {
  hideRecalledRange,
  hideRecalledNode,
  installRecallHiding,
  isRecalledSeq,
  recallDefinition,
  recalledRanges,
  recordRecalledRange,
  RECALL_DEFINITION_KIND,
  resetRecalledRanges,
  setActiveSession,
  wrapAllDefinitions,
} from "./recall-hide.js";

/** 两个会话：seq 各自从 0 开始，区间必须互不影响。 */
const SESSION_A = "session-a";
const SESSION_B = "session-b";

/** 宿主聊天 Definition 的最小形状；buildViewNode 返回给定节点。 */
const chatDefinition = (
  kind: string,
  build: () => ConversationViewNodeLike | null,
): ConversationDefinitionLike => ({
  kind,
  target: "chat",
  match: () => null,
  start: () => undefined,
  update: (context) => context.state,
  buildViewNode: build,
});

/** 装配一个 fake 的 uiConversation.events。 */
const fakeEvents = (definitions: readonly ConversationDefinitionLike[]) => {
  const registered: ConversationDefinitionLike[] = [...definitions];
  const listeners = new Set<() => void>();
  /** 每次 register 调用（含重装配）都记一行，用来观察重注册次数。 */
  const log: string[] = [];
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const events: ConversationEventsLike = {
    register: (definition) => {
      log.push(definition.kind);
      registered.push(definition);
      notify();
      return () => {
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
        notify();
      };
    },
    entries: () => registered,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { events, registered, listeners, log };
};

/** 装配 fake 的 ctx.slots，并记录注册过的选项。 */
const fakeSlots = (entries: readonly ClientSlotEntry[] = []) => {
  const registrations: ClientSlotOptions[] = [];
  const injected: string[] = [];
  const slots: ClientContext["slots"] = {
    inject: (key, contribute) => {
      injected.push(key);
      return contribute();
    },
    register: (options) => {
      registrations.push(options);
      return () => {};
    },
    entries: () => entries,
  };
  return { slots, registrations, injected };
};

/** 装配一个最小 ClientContext。 */
const fakeContext = (
  services: Record<string, unknown>,
  slots: ClientContext["slots"],
): ClientContext => ({
  slots,
  get: (key: string) => services[key],
  effect: (callback) => {
    const dispose = callback();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
});

/** 一个 user 行节点。 */
const userNode = (seq: number, text = "被撤回的一轮"): ConversationViewNodeLike => ({
  key: "input-message:" + seq,
  kind: "user",
  id: String(seq),
  target: "chat",
  anchorSeq: seq,
  visibility: "visible",
  data: { seq, content: [{ type: "text", text }] },
});

afterEach(() => {
  resetRecalledRanges();
  vi.restoreAllMocks();
});

describe("recalled ranges", () => {
  it("records a range once and reports whether it was new", () => {
    expect(recordRecalledRange(SESSION_A, 10, 20)).toBe(true);
    expect(recordRecalledRange(SESSION_A, 10, 20)).toBe(false);
    expect(recalledRanges()).toEqual([{ sessionId: SESSION_A, boundary: 10, end: 20 }]);
  });

  it("keeps ranges sorted and rejects malformed ones", () => {
    recordRecalledRange(SESSION_A, 30, 40);
    recordRecalledRange(SESSION_A, 10, 12);
    expect(recalledRanges()).toEqual([
      { sessionId: SESSION_A, boundary: 10, end: 12 },
      { sessionId: SESSION_A, boundary: 30, end: 40 },
    ]);
    expect(recordRecalledRange(SESSION_A, 20, 10)).toBe(false);
    expect(recordRecalledRange(SESSION_A, Number.NaN, 10)).toBe(false);
    expect(recalledRanges()).toHaveLength(2);
  });

  it("extends a range that shares its boundary instead of adding a second one", () => {
    // 乐观更新用墓碑自己的 seq，落地事件给的是精确结尾：同一个切点只留一段。
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 21);
    expect(recordRecalledRange(SESSION_A, 10, 20)).toBe(false);
    expect(recalledRanges()).toEqual([{ sessionId: SESSION_A, boundary: 10, end: 21 }]);
    expect(isRecalledSeq(20)).toBe(true);
    expect(recordRecalledRange(SESSION_A, 10, 30)).toBe(true);
    expect(recalledRanges()).toEqual([{ sessionId: SESSION_A, boundary: 10, end: 30 }]);
  });

  it("matches both endpoints and nothing outside them", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    expect(isRecalledSeq(9)).toBe(false);
    expect(isRecalledSeq(10)).toBe(true);
    expect(isRecalledSeq(15)).toBe(true);
    expect(isRecalledSeq(20)).toBe(true);
    expect(isRecalledSeq(21)).toBe(false);
  });

  it("treats non-numeric anchors as not recalled", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    expect(isRecalledSeq(undefined)).toBe(false);
    expect(isRecalledSeq("15")).toBe(false);
    expect(isRecalledSeq(Number.NaN)).toBe(false);
  });

  it("keeps every session's ranges apart", () => {
    // 缺陷回归：A 撤过 [100,200]，B 里同样 seq 的行不能被一起藏掉。
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 100, 200);
    expect(isRecalledSeq(150)).toBe(true);

    setActiveSession(SESSION_B);
    recordRecalledRange(SESSION_B, 100, 120);
    expect(isRecalledSeq(150)).toBe(false);
    expect(isRecalledSeq(120)).toBe(true);
    // 同一 seq 在两个会话里各有一段，互不合并。
    expect(recalledRanges()).toEqual([
      { sessionId: SESSION_A, boundary: 100, end: 200 },
      { sessionId: SESSION_B, boundary: 100, end: 120 },
    ]);

    setActiveSession(SESSION_A);
    expect(isRecalledSeq(150)).toBe(true);
    expect(isRecalledSeq(120)).toBe(true);
  });

  it("hides nothing while the active session is unknown", () => {
    // 还没人告诉我们正在看哪个会话：宁可先不隐藏，也不跨会话乱藏。
    recordRecalledRange(SESSION_A, 10, 20);
    expect(isRecalledSeq(15)).toBe(false);
    setActiveSession(SESSION_A);
    expect(isRecalledSeq(15)).toBe(true);
  });

  it("asks for a rebuild only when a range is new", async () => {
    const { events, registered, log } = fakeEvents([
      chatDefinition("input-message", () => userNode(12)),
    ]);
    const { slots } = fakeSlots();
    const hiding = installRecallHiding(fakeContext({ uiConversation: { events } }, slots));
    expect(hiding).toBeDefined();
    const before = registered.length;
    const registeredBefore = log.length;
    expect(hideRecalledRange(SESSION_A, 10, 20)).toBe(true);
    expect(hideRecalledRange(SESSION_A, 10, 20)).toBe(false);
    // 重装配 = 注销并重新注册一次 definition，同一轮只做一次。
    await Promise.resolve();
    expect(registered).toHaveLength(before);
    expect(log).toHaveLength(registeredBefore + 1);
    expect(registered.map((definition) => definition.kind)).toContain(RECALL_DEFINITION_KIND);
    hiding?.dispose();
  });

  it("asks for a rebuild when the active session changes", async () => {
    const { events, log } = fakeEvents([]);
    const { slots } = fakeSlots();
    const hiding = installRecallHiding(fakeContext({ uiConversation: { events } }, slots));
    const registeredBefore = log.length;
    // 同一个会话再设一次不做事。
    setActiveSession(SESSION_A);
    await Promise.resolve();
    expect(log).toHaveLength(registeredBefore + 1);
    setActiveSession(SESSION_A);
    await Promise.resolve();
    expect(log).toHaveLength(registeredBefore + 1);
    // 真的切会话：再重注册一次，旧会话的区间随即不再命中。
    setActiveSession(SESSION_B);
    await Promise.resolve();
    expect(log).toHaveLength(registeredBefore + 2);
    hiding?.dispose();
  });
});

describe("recall tombstones", () => {
  it("records the range carried by a system/message tombstone", () => {
    const match = recallDefinition.match({
      type: "system/message",
      seq: 31,
      data: {
        recall: { sessionId: SESSION_A, boundary: 10, end: 30 },
        message: { id: "recall-31-10" },
      },
    });
    expect(match).toEqual({ id: "31", role: "start" });
    expect(recalledRanges()).toEqual([{ sessionId: SESSION_A, boundary: 10, end: 30 }]);
  });

  it("ignores other events and malformed marks", () => {
    expect(recallDefinition.match({ type: "user/message", seq: 3, data: {} })).toBeNull();
    expect(recallDefinition.match({ type: "system/message", seq: 4, data: {} })).toBeNull();
    expect(
      recallDefinition.match({
        type: "system/message",
        seq: 5,
        data: { recall: { sessionId: SESSION_A, boundary: "10", end: 30 } },
      }),
    ).toBeNull();
    // 没有会话 id 的墓碑无法隔离，一并不收。
    expect(
      recallDefinition.match({
        type: "system/message",
        seq: 6,
        data: { recall: { boundary: 10, end: 30 } },
      }),
    ).toBeNull();
    expect(recalledRanges()).toEqual([]);
  });

  it("keeps the mark as its own state without rendering a row", () => {
    expect(recallDefinition.target).toBeUndefined();
    expect(recallDefinition.buildViewNode).toBeUndefined();
    const state = recallDefinition.start(
      { key: "k", kind: RECALL_DEFINITION_KIND, id: "31", state: undefined },
      {
        event: {
          type: "system/message",
          seq: 31,
          data: { recall: { sessionId: SESSION_A, boundary: 10, end: 30 } },
        },
        role: "start",
      },
    );
    expect(state).toEqual({ sessionId: SESSION_A, boundary: 10, end: 30 });
  });
});

describe("definition-level hiding", () => {
  it("marks a node inside a recalled range hidden and keeps its identity", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    const node = userNode(15);
    const hidden = hideRecalledNode(node);
    expect(hidden).toEqual({ ...node, visibility: "hidden" });
    expect(hidden.key).toBe(node.key);
    expect(hidden.kind).toBe("user");
  });

  it("leaves nodes outside every range untouched", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    const node = userNode(21);
    expect(hideRecalledNode(node)).toBe(node);
  });

  it("leaves a user row from another session visible", () => {
    // 缺陷回归的第二层：定义层改写也必须按会话判断。
    recordRecalledRange(SESSION_A, 100, 200);
    setActiveSession(SESSION_B);
    const node = userNode(150);
    expect(hideRecalledNode(node)).toBe(node);
    setActiveSession(SESSION_A);
    expect(hideRecalledNode(node).visibility).toBe("hidden");
  });

  it("hides assistant rows through their final message seq", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    const node: ConversationViewNodeLike = {
      key: "assistant-step:1:1",
      kind: "assistant-step",
      id: "1:1",
      target: "chat",
      anchorSeq: 9,
      data: { status: "settled", finalNode: { seq: 18 } },
    };
    expect(hideRecalledNode(node).visibility).toBe("hidden");
  });

  it("wraps chat definitions only and does not double-wrap", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    const chat = chatDefinition("input-message", () => userNode(12));
    const other = {
      ...chatDefinition("trajectory-row", () => userNode(12)),
      target: "trajectory",
    };
    const { events } = fakeEvents([chat, other, recallDefinition]);
    wrapAllDefinitions(events);
    wrapAllDefinitions(events);
    expect(
      chat.buildViewNode?.({ key: "k", kind: chat.kind, id: "i", state: undefined }),
    ).toMatchObject({ visibility: "hidden" });
    expect(
      other.buildViewNode?.({ key: "k", kind: other.kind, id: "i", state: undefined }),
    ).toMatchObject({ visibility: "visible" });
  });

  it("keeps a null build result as null instead of inventing a node", () => {
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    const chat = chatDefinition("input-message", () => null);
    const { events } = fakeEvents([chat]);
    wrapAllDefinitions(events);
    expect(
      chat.buildViewNode?.({ key: "k", kind: chat.kind, id: "i", state: undefined }),
    ).toBeNull();
  });
});

describe("installRecallHiding", () => {
  it("degrades to nothing when the conversation service is missing", () => {
    const { slots, registrations } = fakeSlots();
    expect(installRecallHiding(fakeContext({}, slots))).toBeUndefined();
    expect(registrations).toHaveLength(0);
  });

  it("never claims a slot: user rows hide through the definition layer", () => {
    const { slots, registrations, injected } = fakeSlots();
    const hiding = installRecallHiding(
      fakeContext({ uiConversation: { events: fakeEvents([]).events } }, slots),
    );
    expect(hiding).toBeDefined();
    expect(registrations).toHaveLength(0);
    expect(injected).toEqual([]);
    hiding?.dispose();
  });

  it("wraps definitions that appear after installation", () => {
    const { events } = fakeEvents([]);
    const { slots } = fakeSlots();
    const hiding = installRecallHiding(fakeContext({ uiConversation: { events } }, slots));
    setActiveSession(SESSION_A);
    recordRecalledRange(SESSION_A, 10, 20);
    const late = chatDefinition("turn-tail", () => ({
      ...userNode(18),
      kind: "turn-tail",
    }));
    events.register(late);
    expect(
      late.buildViewNode?.({ key: "k", kind: late.kind, id: "i", state: undefined }),
    ).toMatchObject({ visibility: "hidden" });
    hiding?.dispose();
  });

  it("disposes its definition and subscription", () => {
    const { events, registered, listeners } = fakeEvents([]);
    const { slots } = fakeSlots();
    const hiding = installRecallHiding(fakeContext({ uiConversation: { events } }, slots));
    expect(registered.map((definition) => definition.kind)).toEqual([RECALL_DEFINITION_KIND]);
    expect(listeners.size).toBe(1);
    hiding?.dispose();
    expect(registered).toEqual([]);
    expect(listeners.size).toBe(0);
    // 卸载后可以重新安装（下一个页面生命周期）。
    expect(installRecallHiding(fakeContext({ uiConversation: { events } }, slots))).toBeDefined();
  });
});
