import { PANEL_ID, PANEL_LABEL } from "../contract.js";
import type { ClientContext } from "./contract.js";
import { fetchToolkitState } from "./host-api.js";
import { NotesDock } from "./notes-dock.js";
import { ToolkitPanel } from "./panel.js";
import { ToolkitPanelIcon } from "./panel-icon.js";
import { toolkitClientState } from "./state.js";

/** 客户端半只硬依赖 slot 服务。 */
export const inject = ["slots"];

/**
 * 客户端插件体：注册侧边栏入口、toolkit 面板与输入框上方的 Note 面板，
 * 并把宿主侧的工具开关同步到客户端 store。
 * @param ctx - 客户端根上下文。
 */
export const apply = (ctx: ClientContext): void => {
  ctx.effect(
    () => () => {
      toolkitClientState.reset();
    },
    "toolkit: client state",
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 30, label: PANEL_LABEL },
      ToolkitPanelIcon,
    ),
  );
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID }, ToolkitPanel));
  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "nano-flow-notes",
        order: 5,
      },
      NotesDock,
    ),
  );
  void fetchToolkitState()
    .then((tools) => toolkitClientState.publish(tools))
    .catch(() => {
      // 宿主路由不可达时保持默认启用：面板会显示具体错误。
    });
};
