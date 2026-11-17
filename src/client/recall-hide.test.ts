// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
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
  UserRecallNodeView,
  wrapAllDefinitions,
} from "./recall-hide.js";

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
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const events: ConversationEventsLike = {
    register: (definition) => {
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
  return { events, registered, listeners };
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
  cleanup();
  resetRecalledRanges();
  vi.restoreAllMocks();
});

describe("recalled ranges", () => {
  it("records a range once and reports whether it was new", () => {
    expect(recordRecalledRange(10, 20)).toBe(true);
    expect(recordRecalledRange(10, 20)).toBe(false);
    expect(recalledRanges()).toEqual([{ boundary: 10, end: 20 }]);
  });

  it("keeps ranges sorted and rejects malformed ones", () => {
    recordRecalledRange(30, 40);
    recordRecalledRange(10, 12);
    expect(recalledRanges()).toEqual([
      { boundary: 10, end: 12 },
      { boundary: 30, end: 40 },
    ]);
    expect(recordRecalledRange(20, 10)).toBe(false);
    expect(recordRecalledRange(Number.NaN, 10)).toBe(false);
    expect(recalledRanges()).toHaveLength(2);
  });

  it("extends a range that shares its boundary instead of adding a second one", () => {
    // 乐观更新用墓碑自己的 seq，落地事件给的是精确结尾：同一个切点只留一段。
    recordRecalledRange(10, 21);
    expect(recordRecalledRange(10, 20)).toBe(false);
    expect(recalledRanges()).toEqual([{ boundary: 10, end: 21 }]);
    expect(isRecalledSeq(20)).toBe(true);
    expect(recordRecalledRange(10, 30)).toBe(true);
    expect(recalledRanges()).toEqual([{ boundary: 10, end: 30 }]);
  });

  it("matches both endpoints and nothing outside them", () => {
    recordRecalledRange(10, 20);
    expect(isRecalledSeq(9)).toBe(false);
    expect(isRecalledSeq(10)).toBe(true);
    expect(isRecalledSeq(15)).toBe(true);
    expect(isRecalledSeq(20)).toBe(true);
    expect(isRecalledSeq(21)).toBe(false);
  });

  it("treats non-numeric anchors as not recalled", () => {
    recordRecalledRange(10, 20);
    expect(isRecalledSeq(undefined)).toBe(false);
    expect(isRecalledSeq("15")).toBe(false);
    expect(isRecalledSeq(Number.NaN)).toBe(false);
  });

  it("asks for a rebuild only when a range is new", async () => {
    const { events, registered } = fakeEvents([
      chatDefinition("input-message", () => userNode(12)),
    ]);
    const { slots } = fakeSlots();
    const hiding = installRecallHiding(fakeContext({ uiConversation: { events } }, slots));
    expect(hiding).toBeDefined();
    const before = registered.length;
    expect(hideRecalledRange(10, 20)).toBe(true);
    expect(hideRecalledRange(10, 20)).toBe(false);
    // 重装配 = 注销并重新注册一次 definition，同一轮只做一次。
    await Promise.resolve();
    expect(registered).toHaveLength(before);
    expect(registered.map((definition) => definition.kind)).toContain(RECALL_DEFINITION_KIND);
    hiding?.dispose();
  });
});

describe("recall tombstones", () => {
  it("records the range carried by a system/message tombstone", () => {
    const match = recallDefinition.match({
      type: "system/message",
      seq: 31,
      data: { recall: { boundary: 10, end: 30 }, message: { id: "recall-31-10" } },
    });
    expect(match).toEqual({ id: "31", role: "start" });
    expect(recalledRanges()).toEqual([{ boundary: 10, end: 30 }]);
  });

  it("ignores other events and malformed marks", () => {
    expect(recallDefinition.match({ type: "user/message", seq: 3, data: {} })).toBeNull();
    expect(recallDefinition.match({ type: "system/message", seq: 4, data: {} })).toBeNull();
    expect(
      recallDefinition.match({
        type: "system/message",
        seq: 5,
        data: { recall: { boundary: "10", end: 30 } },
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
        event: { type: "system/message", seq: 31, data: { recall: { boundary: 10, end: 30 } } },
        role: "start",
      },
    );
    expect(state).toEqual({ boundary: 10, end: 30 });
  });
});

describe("definition-level hiding", () => {
  it("marks a node inside a recalled range hidden and keeps its identity", () => {
    recordRecalledRange(10, 20);
    const node = userNode(15);
    const hidden = hideRecalledNode(node);
    expect(hidden).toEqual({ ...node, visibility: "hidden" });
    expect(hidden.key).toBe(node.key);
    expect(hidden.kind).toBe("user");
  });

  it("leaves nodes outside every range untouched", () => {
    recordRecalledRange(10, 20);
    const node = userNode(21);
    expect(hideRecalledNode(node)).toBe(node);
  });

  it("hides assistant rows through their final message seq", () => {
    recordRecalledRange(10, 20);
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
    recordRecalledRange(10, 20);
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
    recordRecalledRange(10, 20);
    const chat = chatDefinition("input-message", () => null);
    const { events } = fakeEvents([chat]);
    wrapAllDefinitions(events);
    expect(
      chat.buildViewNode?.({ key: "k", kind: chat.kind, id: "i", state: undefined }),
    ).toBeNull();
  });
});

describe("user seat takeover", () => {
  it("renders nothing for a recalled user row", () => {
    recordRecalledRange(10, 20);
    expect(UserRecallNodeView({ node: userNode(12) })).toBeNull();
  });

  it("delegates to the host user component and forwards its props", () => {
    const seen: Record<string, unknown>[] = [];
    const Host = (props: Record<string, unknown>): unknown => {
      seen.push(props);
      return createElement("div", { "data-testid": "host-user" }, "宿主气泡");
    };
    const { slots } = fakeSlots([
      { options: { id: "other", key: "assistant-step" }, component: () => null },
      { options: { key: "user" }, component: Host },
    ]);
    const hiding = installRecallHiding(
      fakeContext({ uiConversation: { events: fakeEvents([]).events } }, slots),
    );
    expect(hiding).toBeDefined();
    render(createElement(UserRecallNodeView, { node: userNode(12), t: () => "x" }));
    expect(screen.getByTestId("host-user")).toBeDefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.["node"]).toMatchObject({ kind: "user" });
    // 宿主的 user 行要用装饰链渲染来源；本条目声明不了那个子槽，补一条空链。
    const chain = seen[0]?.["renderSlotChain"] as (() => unknown) | undefined;
    expect(typeof chain).toBe("function");
    expect(chain?.()).toBeNull();
    hiding?.dispose();
  });

  it("keeps a host-provided slot chain untouched", () => {
    const seen: Record<string, unknown>[] = [];
    const Host = (props: Record<string, unknown>): unknown => {
      seen.push(props);
      return null;
    };
    const { slots } = fakeSlots([{ options: { key: "user" }, component: Host }]);
    const hiding = installRecallHiding(
      fakeContext({ uiConversation: { events: fakeEvents([]).events } }, slots),
    );
    const chain = (): string => "host-chain";
    render(createElement(UserRecallNodeView, { node: userNode(12), renderSlotChain: chain }));
    expect(seen[0]?.["renderSlotChain"]).toBe(chain);
    hiding?.dispose();
  });

  it("falls back to a self-drawn bubble when the host component is missing", () => {
    const { slots } = fakeSlots([]);
    const hiding = installRecallHiding(
      fakeContext({ uiConversation: { events: fakeEvents([]).events } }, slots),
    );
    render(createElement(UserRecallNodeView, { node: userNode(12, "降级文本") }));
    expect(screen.getByText("降级文本")).toBeDefined();
    hiding?.dispose();
  });

  it("claims the user cell at priority -1 with the chat dictionary", () => {
    const { slots, registrations } = fakeSlots();
    const hiding = installRecallHiding(
      fakeContext({ uiConversation: { events: fakeEvents([]).events } }, slots),
    );
    expect(registrations[0]).toMatchObject({
      name: "conversation.chat.node",
      key: "user",
      priority: -1,
      locale: "chat",
    });
    hiding?.dispose();
  });

  it("survives a lost seat and keeps the definition-level hide", () => {
    const { slots, registrations } = fakeSlots();
    const failing: ClientContext["slots"] = {
      ...slots,
      register: (options) => {
        registrations.push(options);
        throw new Error("keyed slot already has an entry for key user at priority -1");
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hiding = installRecallHiding(
      fakeContext({ uiConversation: { events: fakeEvents([]).events } }, failing),
    );
    expect(hiding).toBeDefined();
    expect(registrations).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    hiding?.dispose();
  });
});

describe("installRecallHiding", () => {
  it("degrades to nothing when the conversation service is missing", () => {
    const { slots, registrations } = fakeSlots();
    expect(installRecallHiding(fakeContext({}, slots))).toBeUndefined();
    expect(registrations).toHaveLength(0);
  });

  it("wraps definitions that appear after installation", () => {
    const { events } = fakeEvents([]);
    const { slots } = fakeSlots();
    const hiding = installRecallHiding(fakeContext({ uiConversation: { events } }, slots));
    recordRecalledRange(10, 20);
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

  it("disposes its definition, subscription and seat", () => {
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
