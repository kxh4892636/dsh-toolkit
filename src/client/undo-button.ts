import {
  createElement,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type FC,
} from "react";
import type { UndoAvailability, UndoTurnResponse } from "../contract.js";
import { clientService, hasMethod, type ClientContext } from "./contract.js";
import { ConfirmModal } from "./confirm-modal.js";
import { fetchUndoAvailability, HostApiError, runUndoTurn } from "./host-api.js";
import { dropDraft, peekDraft, rememberDraft, takeDraft } from "./draft-restore.js";
import { hideRecalledRange, setActiveSession } from "./recall-hide.js";
import { toolkitClientState } from "./state.js";
import { ensureToolkitStyles } from "./stylesheet.js";

/** 撤回按钮的 props：slot 标准 props + 注册时注入的客户端上下文。 */
interface UndoButtonProps {
  readonly sessionId: string;
  readonly ctx: ClientContext;
  /** 会话快照选择器（`conversation.input.right` 的标准 props），用于感知轮次起止。 */
  readonly useSession?: <S>(selector: (snapshot: SessionSnapshotLike) => S) => S;
  /** composer 的标准动作面；撤回后用它把原文写回同一个会话的输入框。 */
  readonly inputActions?: InputActionsLike;
}

/** composer 动作面里本插件用到的两个写草稿入口（宿主 `InputActions`）。 */
interface InputActionsLike {
  readonly setDraft?: (text: string) => void;
  readonly persistDraft?: () => void;
}

/** 只声明要读的会话快照字段（宿主 `SessionSnapshot`）。 */
interface SessionSnapshotLike {
  readonly running?: boolean;
  readonly blank?: boolean;
  readonly pendingSubmissions?: readonly unknown[];
}

/** 「撤回」的图标：向左回转的箭头，尺寸与工具栏其它控件一致（14px）。 */
const UndoIcon: FC = () => {
  return createElement(
    "svg",
    {
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.5,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    },
    createElement("path", { d: "M6.25 4.25 3 7.5l3.25 3.25" }),
    createElement("path", { d: "M3 7.5h6.25a3.25 3.25 0 0 1 0 6.5H7.5" }),
  );
};

/**
 * composer 工具栏的「撤回」按钮：位于模型选择左侧（`conversation.input.right`）。
 * 只负责确认与发起，执行在宿主：就地追加一条墓碑、把本轮输入还给客户端。
 * 行从对话里消失是客户端的事（见 `recall-hide.ts`），会话 id 不变、不换会话。
 */
export const UndoButton: FC<UndoButtonProps> = (props) => {
  // 每次渲染都把「正在看的会话」同步给区间表：seq 每个会话都从 0 开始，
  // 不知道会话就不隐藏（见 recall-hide.ts 的 isRecalledSeq）。切换会话时这里触发一次重装配。
  setActiveSession(props.sessionId);
  const tools = useSyncExternalStore(
    (listener: () => void) => toolkitClientState.subscribe(listener),
    () => toolkitClientState.getSnapshot(),
  );
  const enabled = tools.tools.find((tool) => tool.id === "undo-turn")?.enabled ?? true;
  // 轮次起止（running 翻转）本身就是「可撤销目标」变化的信号：只在挂载时探测会让
  // 会话从第 1 轮涨到第 2 轮后仍显示为禁用，必须切换会话才刷新。
  const running = props.useSession?.((snapshot) => snapshot.running === true) ?? false;
  const queued =
    props.useSession?.((snapshot) => (snapshot.pendingSubmissions?.length ?? 0) > 0) ?? false;
  const [availability, setAvailability] = useState<UndoAvailability | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      setAvailability(undefined);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    setAvailability(undefined);
    // 第一次探测可能早于宿主打开该会话（或历史尚未装载），此时会拿到 session-not-live；
    // 因此不可用时短暂重试，而不是把「禁用」写死在挂载那一刻。
    const probe = (): void => {
      fetchUndoAvailability(props.sessionId, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setAvailability(next);
          if (next.available === false && attempts < 30) {
            attempts += 1;
            timer = setTimeout(probe, 1000);
          }
        })
        .catch(() => {
          if (controller.signal.aborted || attempts >= 30) return;
          attempts += 1;
          timer = setTimeout(probe, 1000);
        });
    };
    probe();
    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, props.sessionId, running, queued]);

  usePendingDraft(props.inputActions, props.sessionId);

  const confirm = useCallback((): void => {
    setBusy(true);
    setError(undefined);
    runUndoTurn(props.sessionId)
      .then((result) => applyUndone(props.ctx, props.sessionId, result, props.inputActions))
      .then(() => setOpen(false))
      .catch((reason: unknown) => setError(describe(reason)))
      .finally(() => setBusy(false));
  }, [props.ctx, props.inputActions, props.sessionId]);

  if (!enabled) return null;
  ensureToolkitStyles();
  const available = availability?.available === true;
  return createElement(
    "div",
    { style: { display: "inline-flex", alignItems: "center" } },
    createElement(
      "button",
      {
        type: "button",
        title: available ? "撤回上一轮" : hintOf(availability),
        "aria-label": "撤回上一轮",
        disabled: !available || busy,
        className: "dshtk-undo-trigger",
        onClick: () => {
          setError(undefined);
          setOpen(true);
        },
      },
      createElement("span", { className: "dshtk-undo-trigger-icon" }, createElement(UndoIcon)),
      createElement("span", { className: "dshtk-undo-trigger-label" }, "撤回"),
    ),
    createElement(ConfirmModal, {
      open,
      title: "撤回这一轮会话？",
      message:
        "本轮消息会从对话里移除，用户输入回到输入框，可修改后重新发送。已执行的文件改动与命令不会回滚。",
      ...(availability?.prompt === undefined ? {} : { preview: availability.prompt }),
      confirmLabel: busy ? "正在撤回…" : "撤回",
      cancelLabel: "取消",
      busy,
      ...(error === undefined ? {} : { error }),
      onConfirm: confirm,
      onCancel: () => {
        if (busy) return;
        setOpen(false);
        setError(undefined);
      },
    }),
  );
};

/**
 * 撤回成功后的两件事，顺序即优先级：
 * 1. **本地先藏**：用响应里的 `{boundary, seq}` 立即记区间并请求重装配，
 *    行马上消失，不必等墓碑事件从会话流里回来（乐观更新）。
 * 2. **原文回填**：走 composer 的 `setDraft`，输入框立刻拿到原文；
 *    拿不到 composer 时登记为待回填，由本按钮或服务面兜底落地。
 *
 * 会话 id 不变、不换会话、不摘会话行：就地撤回只追加一条墓碑。
 * @param ctx - 客户端根上下文。
 * @param sessionId - 被撤回的会话（回填草稿的键）。
 * @param result - 宿主返回的撤回切点与原文。
 * @param inputActions - composer 的标准动作面。
 */
const applyUndone = (
  ctx: ClientContext,
  sessionId: string,
  result: UndoTurnResponse,
  inputActions: UndoButtonProps["inputActions"],
): void => {
  hideRecalledRange(sessionId, result.boundary, result.seq);
  if (result.prompt === "") return;
  const setDraft = inputActions?.setDraft;
  if (typeof setDraft === "function") {
    setDraft(result.prompt);
    inputActions?.persistDraft?.();
    return;
  }
  rememberDraft(sessionId, result.prompt);
  scheduleFallback(ctx, sessionId);
};

/**
 * 兜底：组件路径没来得及消费时，等服务面 binding 稳定后再写一次。
 * @param ctx - 客户端根上下文。
 * @param sessionId - 待回填的会话。
 */
const scheduleFallback = (ctx: ClientContext, sessionId: string): void => {
  setTimeout(() => {
    applyPendingDraft(ctx, sessionId);
  }, FALLBACK_DELAY_MS);
};

/**
 * 兜底写入：直接经 `conversation.input.requestDraftInitialization` 落到当前 binding 上。
 * @param ctx - 客户端根上下文。
 * @param sessionId - 待回填的会话。
 * @returns 是否真的写入（没有待回填草稿、服务缺失或 binding 尚未建立时为 false）。
 */
export const applyPendingDraft = (ctx: ClientContext, sessionId: string): boolean => {
  const prompt = peekDraft(sessionId);
  if (prompt === undefined) return false;
  const sessions = clientService<{ binding(id: string): unknown }>(ctx, "sessions");
  const conversation = clientService<{
    input?: { requestDraftInitialization?: (binding: unknown, options: object) => string };
  }>(ctx, "conversation");
  const initialize = conversation?.input?.requestDraftInitialization;
  if (!hasMethod<{ binding(id: string): unknown }>(sessions, "binding")) return false;
  if (typeof initialize !== "function") return false;
  try {
    const binding = sessions.binding(sessionId);
    if (binding === undefined) return false;
    initialize.call(conversation?.input, binding, { prompt, whenDraftExists: "replace" });
    dropDraft(sessionId);
    return true;
  } catch {
    // binding 仍在切换：留给下一次会话重挂载再试。
    return false;
  }
};

/** 兜底延迟：足够等到 composer 挂载，又不至于让用户等不到输入框。 */
const FALLBACK_DELAY_MS = 1500;

/**
 * 挂载时取走待回填草稿并写进输入框（兜底路径登记的草稿在这里落地）。
 * @param inputActions - composer 的标准动作面（`setDraft` 是宿主公开的写草稿入口）。
 * @param sessionId - 当前会话。
 */
const usePendingDraft = (
  inputActions: UndoButtonProps["inputActions"],
  sessionId: string,
): void => {
  useEffect(() => {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (): void => {
      const prompt = peekDraft(sessionId);
      if (prompt === undefined) return;
      const setDraft = inputActions?.setDraft;
      if (typeof setDraft !== "function") {
        if (attempts >= 20) return;
        attempts += 1;
        timer = setTimeout(apply, 100);
        return;
      }
      takeDraft(sessionId);
      setDraft(prompt);
      inputActions?.persistDraft?.();
    };
    apply();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [inputActions, sessionId]);
};

const hintOf = (availability: UndoAvailability | undefined): string => {
  switch (availability?.reason) {
    case "no-previous-turn":
      return "没有可回退的上一轮";
    case "session-not-live":
      return "会话尚未在宿主中打开";
    case "agent-busy":
      return "这一轮还在跑，先停下再撤回";
    case "unsupported-host":
      return "当前宿主不支持撤回";
    case "tool-disabled":
      return "「撤回」工具已关闭";
    default:
      return "暂不可用";
  }
};

const describe = (reason: unknown): string => {
  if (reason instanceof HostApiError) return `撤回失败：${reason.message}`;
  if (reason instanceof Error) return `撤回失败：${reason.message}`;
  return "撤回失败：无法连接宿主";
};
