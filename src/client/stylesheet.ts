/**
 * toolkit 的样式表：与 DSH 原生样式同一套做法——每个插件注入一张按 `data-plugin-css`
 * 标记的全局样式表，只写 token（`--dsw-*`），不出现任何字面色值。
 *
 * - 面板：复刻宿主设置页的 section/card/row 度量（`ui-settings-models` 的
 *   `.section/.title/.intro/.rows/.rowCard/.rowHead/.rowName/.rowTag/.rowActions`）：
 *   卡片用 `--dsw-alias-settings-card-fill/-stroke` + `--dsw-radius-xl` + 0.5px 描边。
 * - 开关：直接复用宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Switch`（它自己读
 *   `--dsw-alias-switch-thumb`），不用自绘控件。
 */

const STYLE_ID = "@kxh4892636/dsh-toolkit/toolkit.css";

const css = `
/* ── 面板：设置页的 section / rowCard 度量 ─────────────────────────────── */
.dshtk-panel {
  box-sizing: border-box;
  height: 100%;
  overflow-y: auto;
  padding: 24px;
  color: var(--dsw-alias-label-primary);
}
.dshtk-section {
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dshtk-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.dshtk-intro {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 22px;
}
.dshtk-notice {
  margin: 0;
  color: var(--dsw-alias-state-warn-label);
  font-size: 12px;
  line-height: 18px;
}
.dshtk-rows {
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
}
.dshtk-row-card {
  position: relative;
  border: .5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  display: flex;
}
.dshtk-row-head {
  align-items: center;
  gap: 10px;
  display: flex;
}
.dshtk-row-identity {
  align-items: center;
  gap: 6px;
  min-width: 0;
  display: inline-flex;
}
.dshtk-row-name {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
}
.dshtk-row-tag {
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-xs);
  color: var(--dsw-alias-label-secondary);
  flex: none;
  padding: 1px 6px;
  font-family: var(--ds-font-family-code);
  font-size: 11px;
  line-height: 16px;
}
.dshtk-row-actions {
  align-items: center;
  gap: 4px;
  margin-left: auto;
  display: inline-flex;
}
.dshtk-row-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

/* ── 设置下拉：开关旁的小箭头 + 浮层 ─────────────────────────────────── */
.dshtk-settings-popover {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  box-sizing: border-box;
  padding: 12px;
  background: var(--dsw-alias-settings-card-fill);
  border: .5px solid var(--dsw-alias-settings-card-stroke);
  border-radius: var(--dsw-radius-xl);
}

/* ── 设置区：数字输入与保存按钮 ───────────────────────────────────────── */
.dshtk-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-top: 10px;
}
.dshtk-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 16px;
}
.dshtk-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.dshtk-field-label {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
/* 输入框右侧的恢复默认图标：宿主 Input 只有前置 icon，这里自己贴一个，
   内层 input 让出右内边距，文字不压到图标。 */
.dshtk-field-control {
  position: relative;
  display: block;
}
.dshtk-field-control input {
  padding-right: 22px;
}
.dshtk-field-reset {
  position: absolute;
  top: 50%;
  right: 6px;
  display: grid;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  transform: translateY(-50%);
  place-items: center;
  cursor: pointer;
}
.dshtk-field-reset:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
/* 宽度交给面板网格；外观由宿主 Input 自己负责。
   宿主 Input 可能是「外层容器 + 内层 input」两层结构，两层的盒模型都要压住。 */
.dshtk-input,
.dshtk-input input {
  box-sizing: border-box;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
.dshtk-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  padding-top: 4px;
}

/* ── ready 面板：输入框上方的可折叠列表 ─────────────────────────────── */
.dshtk-ready {
  box-sizing: border-box;
  flex: none;
  overflow: hidden;
  margin: 0 auto;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  max-width: calc(
    var(--dsh-composer-card-max-width) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-specific-tip);
}
.dshtk-ready-body {
  flex-direction: column;
  gap: 8px;
  padding: 6px 12px;
  display: flex;
}
.dshtk-ready-header {
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  display: flex;
}
.dshtk-ready-lead,
.dshtk-ready-chevron {
  display: grid;
  flex: none;
  place-items: center;
  color: var(--dsw-alias-label-tertiary);
}
.dshtk-ready-title {
  flex: none;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshtk-ready-progress {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshtk-ready-list {
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
}
.dshtk-ready-group {
  flex-direction: column;
  gap: 6px;
  display: flex;
}
.dshtk-ready-group-label {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-caption);
}
.dshtk-ready-item {
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  display: flex;
}
.dshtk-ready-glyph {
  display: grid;
  flex: none;
  place-items: center;
  width: 16px;
  height: 16px;
}
.dshtk-ready-glyph-pending {
  color: var(--dsw-alias-label-caption);
}
.dshtk-ready-glyph-in_progress {
  color: var(--dsw-alias-state-business-primary);
  animation: dshtk-ready-spin 1s linear infinite;
}
.dshtk-ready-glyph-waiting {
  color: var(--dsw-alias-state-warn-label);
}
.dshtk-ready-glyph-blocked {
  color: var(--dsw-alias-state-error-primary);
}
@keyframes dshtk-ready-spin {
  to {
    transform: rotate(360deg);
  }
}
.dshtk-ready-id {
  flex: none;
  font-family: var(--ds-font-family-code);
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dshtk-ready-item-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshtk-ready-reason {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-state-warn-label);
  font-size: 12px;
}

/* ── note 面板：输入框上方的未完成 note 列表（度量照 Todo 面板）────────── */
.dshtk-notes {
  box-sizing: border-box;
  flex: none;
  overflow: hidden;
  margin: 0 auto;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-side-clearance) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  max-width: calc(
    var(--dsh-composer-card-max-width) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset) -
    var(--dsh-composer-dock-inset)
  );
  border: .5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-specific-tip);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dshtk-notes-body {
  flex-direction: column;
  gap: 8px;
  padding: 6px 12px;
  display: flex;
}
.dshtk-notes-header {
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  display: flex;
}
.dshtk-notes-title {
  flex: none;
  font-size: 13px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dshtk-notes-progress {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshtk-notes-toggle {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.dshtk-notes-list {
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  display: flex;
}
.dshtk-notes-item {
  min-width: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
/* 悬浮锚点覆盖整行，提示才对得上「悬浮到这一项」。 */
.dshtk-notes-row {
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
  display: flex;
  cursor: default;
}
.dshtk-notes-item:hover .dshtk-notes-content {
  color: var(--dsw-alias-label-primary);
}

.dshtk-notes-status {
  flex: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-caption);
}
.dshtk-notes-item[data-status="in_progress"] .dshtk-notes-status {
  color: var(--dsw-alias-state-business-primary);
}
.dshtk-notes-item[data-status="blocked"] .dshtk-notes-status {
  color: var(--dsw-alias-state-error-primary);
}
.dshtk-notes-content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 未完成列表为空时的空态：一行 dim 文本，不可点击。 */
.dshtk-notes-empty {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-tertiary);
}
`;

/** 注入一次工具箱样式；没有 DOM（如静态渲染）时静默跳过。 */
export const ensureToolkitStyles = (): void => {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "@kxh4892636/dsh-toolkit";
  tag.dataset["pluginCss"] = STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
};
