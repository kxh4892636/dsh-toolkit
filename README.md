# dsh-toolkit

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件:**一组可独立开关的工具**.
侧边栏的 `toolkit` 面板逐项列出工具与开关,开关状态由宿主持久化,刷新与重启后保持.**所有工具默认关闭**,需要先在面板里打开.

当前工具:

| 工具 id         | 名称                      | 默认 | 作用                                                         |
| --------------- | ------------------------- | ---- | ------------------------------------------------------------ |
| `nested-skill`  | 嵌套 skill 发现           | 关   | 在 `.agents` 树内任意深度发现 `SKILL.md`(内建一层形态之外)   |
| `undo-turn`     | 撤回                      | 关   | 在会话工具栏,模型选择左侧加"撤回"按钮,撤销最后一轮会话       |
| `office-skills` | 移除 dsh 自带 office 技能 | 关   | 屏蔽宿主内置的 office / office-* 技能(provider `dsh-office`) |

另有一个 **Agent 预设 `nano-flow`**(不是面板开关):安装本插件后预设选择器里多出"Nano Flow",
只有选中它的会话才挂载 Nano Flow 的提示词,工具与 skill.

## 安装

桌面版自带 CLI 管理 `desktop` profile;`PATH` 上的 `dsh` 属于另一套安装,不认该 profile.

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add <absolute path to the packed .tgz>
```

profile 的 `dsh.profile.bundles` 会多出本包及其 `cordis.patch.yml` 挂载.宿主启动时组合 bundle,
因此**重启宿主**(或新建会话)后生效.

## 样式方案

与宿主同一套做法:插件注入一张带 `data-plugin-css` 标记的全局样式表,**只写 `--dsw-*` token,不出现字面色值**;能复用原生组件的地方直接复用,不重画控件.

| 位置             | 复用的原生样式 / 组件                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 面板容器与行卡片 | 复刻设置页 `section / rows / rowCard / rowHead / rowName / rowTag / rowActions` 的度量:`--dsw-alias-settings-card-fill/-stroke`,`--dsw-radius-xl`,`0.5px` 描边,`12px 14px` 内边距 |
| 工具开关         | 宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Switch`(滑块自带 `--dsw-alias-switch-thumb`)                                                                                     |
| 撤回触发器       | 复刻 `ui-permission-presets` 的 `.trigger` 度量与 `:hover`/`:disabled`/`focus-visible` 状态                                                                                       |
| 撤回确认弹窗     | 宿主 `Modal` + `Button`,正文层级用本插件 token 类                                                                                                                                 |
| 图标             | `currentColor` 描边 SVG,尺寸由 class 决定(与宿主 `.triggerIcon svg` 同规则)                                                                                                       |

## 工具一:嵌套 skill 发现

把任意深度的 `SKILL.md` 注册成宿主 skill provider,典型布局:

```text
.agents/
└── skills/
    └── nano-flow/
        └── references/
            └── skills/
                └── code-spec/
                    └── SKILL.md          ← 内建 provider 看不到,本工具能看到
```

注册名取 skill frontmatter 的 `name` 原样;rank 是同来源一层形态的 rank 加一
(项目 `.agents` 201 / custom 301 / 用户 `.agents` 501),因此同来源同名师冲突时显式声明的
一层形态获胜,跨来源仍按宿主来源序.某个扫描根的 watcher 起不来时,本次目录以
`complete: false` 返回,注册表保留上一份结果而不是缓存它.关闭该工具会卸载 provider,
嵌套 skill 立刻从目录里消失.

## 工具二:撤回

会话界面的 composer 工具栏中,模型选择器左侧出现"撤回"按钮:

- 会话只有一轮(没有可回到的上一轮)时按钮置灰;正在跑一轮时也置灰(就地改写不能抽掉进行中那一步的历史).
- 控件样式与 composer 的"权限选择"逐条一致(同样的字体/字号/颜色/hover),文字左侧带 14px 回转箭头,与模型选择器之间的 gap 收到 6px.
- 确认弹窗外壳用宿主 `Modal`,动作用宿主 `Button`.
- 点击弹出确认框(宿主原生确认对话框布局:标题/说明 + 原文预览 + 取消/确认),取消不改动任何状态.
- 原文回填:确认后把该轮 `user/message` 的文本写回**同一会话**的 composer 草稿(`inputActions.setDraft` + `persistDraft()`);composer 尚未挂载时先登记为"待回填",由该会话自己的按钮或 1.5s 服务面兜底落地.
- 可用性随会话轮次变化自动刷新,宿主尚未打开会话时会短暂重试,无需切换会话.
- 确认后:清掉该会话排队中的输入 → 在**同一个会话**里追加一条墓碑 → 会话 id 不变:不换会话、不删会话、不动置顶位与工作区记账.

### 就地撤回:一条墓碑遮蔽一段表面

宿主的会话日志是**仅追加**的事件源记录(`@deepseek-ai/dsh-session`),但模型看到的历史是它的**表面**(`surfaceOp`):
每个 `session.append` 都带 `surfaceOp`,要么 `"append"` 接在尾部,要么 `{op:"replace", startSeq, endSeq}` 把一段节点换成自己;
`deriveMessages()`(下一次请求的模型输入)就是表面节点逐个投影出来的结果. 宿主没有删除/截断 API,`replace` 是唯一能让表面变短的手段.

于是"撤回"= 往日志追加**一个**事件:

```js
session.append(
  "system/message",
  {
    turn,
    step, // v4 准入要求正整数,取被撤回那条消息所在的轮
    recall: { boundary, end }, // 客户端半据此隐藏这几行
    message: {
      id: `recall-${seq}-${boundary}`,
      role: "system",
      source: { kind: "system-prompt" },
      content: [],
    },
  },
  {
    surfaceOp: { op: "replace", startSeq: boundary, endSeq: end },
    sourceEventSeqs: shadowed,
  },
);
```

- `boundary`:被撤回那一轮**第一条用户消息**的 seq(该轮没有用户文本时退回该轮第一条 assistant 消息);它必须仍是当前表面上的 `append` 节点,否则报 `no-previous-turn`.
- `end`:当前表面最后一个节点的 seq.
- `shadowed`:当前表面从 `boundary` 到 `end` 的全部节点,必须逐个写进 `sourceEventSeqs`(宿主会校验,漏一个就拒写).
- 空内容的 `system/message` 不投影出任何消息,所以替换之后模型看到的历史正好停在上一轮结束;替换本身是日志里的一行,重启后可重放.
- 撤回前先清掉该会话排队中的输入(`sessionController.state` 读出,逐条 `updateQueue({action:{kind:"remove"}})`):否则那条待发消息会立刻开一轮,把刚遮蔽的历史重新长出来. 宿主不暴露队列能力时只记一条 warn,撤回照常进行.
- 界面同步:客户端半读出墓碑里的 `data.recall`(含 `sessionId`),把**当前会话**里 `boundary..end` 区间的聊天行置 `visibility:"hidden"`(宿主的 `isVisibleChatNode` 按这个字段过滤;用户提问行也走同一条定义层通道). 区间按会话隔离,所以在 A 会话撤回不会影响 B 会话的行. 点确认后先用响应里的 `{boundary, seq}` 乐观隐藏,不等墓碑事件回流.

### 边界(不做的事)

- **不回滚副作用**:已写入的文件,已执行的命令不会撤销.
- **不回填附件**:只回填该轮 `user/message` 的文本;图片与文件附件需要重新选择.
- **不是时间旅行**:撤销的是"最后一轮",不是任意轮.
- **不重编轮号**:撤回后 turn 计数继续往上走;消息编号与 Plan 轨迹日志同样不回退.
- **token 记账不缩水**:就地撤回只写一条墓碑(不动 `compaction/prune` 的影子价),上下文占用会在下一次真实压缩前偏大.

## 工具三:移除 dsh 自带 office 技能

桌面宿主在启动时用代码挂载 `@deepseek-ai/dsh-skill-office`,把 `office`,`office-docx`,
`office-pptx`,`office-xlsx`,`office-render`,`office-recalculate`,`office-export-pdf`
七个技能注册成 provider `dsh-office`(全局层,rank 600).这些技能不在 profile 配置里,
`.dsh` 的 patch 关不掉,所以本工具改在**读取面**上做屏蔽:

- 包装 `ctx.skills` 的 `list` / `snapshot` / `get`,命中判据的条目既不进技能目录,也加载不到;
- 判据:`provider === "dsh-office"`,或 `bundled` 来源的 `office` / `office-*`(provider 被改名时兜底);
- 用户自己的 `office-*`(`user-dsh` / `project-dsh` 来源)不受影响;
- 不注销 provider,不删安装目录里的 `SKILL.md`,不改状态文件以外的任何东西;关闭开关即还原三个入口.

宿主升级带来的 provider 改名会让"provider 判据"失效,此时 bundled + 名字判据仍然生效;
若两个判据都不命中(例如上游换了来源标签),开关会静默无效--真机验收时看 skill 目录即可发现.

## 预设:Nano Flow

`nano-flow` 是 toolkit 面板里的一个开关(默认关):打开时根插件调用
`ctx.agentPresets.register()` 把预设注册进 roster,关闭时注销.预设行挂载的也是本包的
唯一入口 `dist/index.mjs`,靠 `config.nanoFlowOnly: true` 只走预设内的那一半.预设的 standing mount 在独立
作用域里注册,所以**开关就是预设是否出现**:打开后预设选择器里才有"Nano Flow",选中它的
会话才有提示词,工具与 skill.预设行直接挂 `@deepseek-ai/dsh-tool-executor-ptc`(旧的
`dsh-agent-tool-presentation` 选型器已弃用),因此宿主必须挂 code runtime,否则预设激活失败.

开关右侧的箭头按钮(`Nano Flow 设置`)只在开关打开时出现,点开是上限与轮转阈值的下拉面板.

挂载后会话里多出五样东西:

| 类别       | 内容                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定提示词 | `prompts/system.md` 与 `.agents/domains/GUIDE.md` 的当前快照拼接, 作为系统提示词段 `order: 1` 注入                                                                            |
| 每轮提示词 | `prompts/user.md`, 作为运行时上下文在每轮第一次 pre-step 后追加; 不冒充用户消息, UI 以 context 卡片显示                                                                       |
| 工具       | `nano_flow_create`(domain / plan / note 的目录与模板)、`nano_flow_bind`(绑定/切换 Plan) 与 `nano_flow_check`(校验 + 自动修复 + 生成全部索引)                                  |
| skill      | `skills/` 动态发现: `to-skill`,`code-spec`,`learning`,`ponytail`,`ponytail-audit`,`ponytail-review`,`ap`,`ad`                                                                 |
| Note 面板  | 输入框上方 dock: 已绑定 Plan 时常驻, **默认展开**、点标题收起, 列未完成 note(中文状态名 + 名称, hover 显示描述/原因/下一步), 列表为空显示「全部完成」; 客户端 5s 轮询宿主路由 |
| Plan 日志  | 已绑定会话每轮把 `<plan>/log.jsonl` 追加一条 compact 轨迹(user/assistant/工具摘要/usage/seq), 绑定表在 `$DSH_HOME/toolkit/nano-flow-plan-bindings.json`                       |

**目录布局**

```text
.agents/domains/
├── GUIDE.md                       # 会话启动快照（L3）；正文只由 dream 维护，create 仅补空模板
├── CONTEXT-MAP.md                 # 生成：Contexts + Relationships
└── {domain-name}/
    ├── CONTEXT.md                 # 职责、术语、relations
    ├── questions/
    │   ├── index.md               # 生成
    │   └── 001-中文问题.md
    ├── adr/
    │   ├── index.md               # 生成
    │   └── 001-中文决策.md
    ├── workflows/
    │   ├── index.md               # 生成
    │   └── 001-中文工作流/
    │       └── 001-中文工作流.md
    └── plans/{active|reference|archived}/
        └── YYYY-MM-DD-中文工作名/
            ├── spec.md
            ├── notes_index.md     # 生成
            └── 001-中文标题.md
```

story 已并入 spec，不再创建 `story.md`。索引文件都是生成物，模型不需要手改；`nano_flow_check`
每次运行都会按源文档重新生成。

**YAML 头**

所有领域文档以 YAML 头开始，固定包含 `name` 与 `description`；自由扩展放进 `metadata`：

```yaml
---
name: 001-取消订单
description: 客户可以取消未发货订单。
status: pending
reason:
related_noted: []
next_step: 读取 spec 并确认接口契约
metadata:
  owner: 订单组
---
```

- `name` 是索引的唯一键；`adr` / `question` / `note` / `workflow` 的 name 必须带三位数字前缀，
  并与文件名或目录名一致；`related_noted` 引用同一个 Plan 里的 note name。
- CONTEXT 额外有 `relations: [{ to: 目标域目录名, description: 关系说明 }]`，`CONTEXT-MAP.md`
  由脚本汇总生成；跨域关系只在源域定义一次。
- ADR 可选 `status`：`proposed | accepted | deprecated | superseded`。
- spec 固定 `status`：`pending | in_progress | completed`，由全部 note 派生。
- note 固定 `status`：`pending | in_progress | blocked | completed`；`blocked` 时 `reason` 必填，
  其他状态不写；`next_step` 是单行下一步。`related_noted` 只表达关联，不构成 DAG。
  **只有用户验收通过后才写 `completed`**；交付完成但未验收时置 `blocked` 并在 `reason` 写“等待用户验收”。
  `blocked` 表示这条 note 无法正常继续：等待用户验收或确认、被其他 note 阻塞、外部前置未就绪等。
- spec 正文自由组织，只在最后保留 `## 追踪 Note`；check 用未完成 note 自动生成该表。
  `notes_index.md` 收录全部 note（name / description / related_noted）。

**工具**

- `nano_flow_create`：`kind=domain` 建 `CONTEXT.md`、questions / adr / workflows 与 `GUIDE.md` 空模板；
  `kind=plan` 建 `spec.md` 与 `notes_index.md`；`kind=note` 建一条 note（可自动取下一个三位编号）。
  只补缺失文件，不覆盖已有内容；GUIDE 正文仍只由 dream 维护。
- `nano_flow_bind`：把当前会话绑定到指定 Plan（可按 `domain` / `lifecycle` 消歧），是**唯一绑定入口**。
  同一会话只保留一个绑定，再次调用即切换；Note 看板与后续 `log.jsonl` 立即跟随。
  未绑定时看板不显示、`log.jsonl` 也不落盘。
- `nano_flow_check`：校验 YAML 头、三位 name、篇幅、status / reason / related_noted 与 spec 状态派生，
  以及页面文末 `## 相关` 互链（目标存在、原因非空）与 `GUIDE.md` 体积；
  同时生成/更新 `CONTEXT-MAP.md`、`questions/index.md`、`adr/index.md`、`workflows/index.md`、
  `notes_index.md` 与 spec 的 `## 追踪 Note`。可用 `domain` / `plan` 缩小范围，`strict=false`
  把旧格式文档记为警告并跳过。**check 不写 Plan 绑定**。
- 确定性自动修复（结果进「已自动修复 N 项」，只报不改的仍进 errors）：spec 状态按 note 派生、
  name 与文件名不一致时对齐并联动 `related_noted`、非 blocked 的 note 去掉 `reason`、
  多行头字段折成单行、域下缺 `questions/` 时建目录。

**上限与轮转**

- 所有数字在 **开关旁的下拉设置面板**维护（持久化到 `$DSH_HOME/toolkit/nano-flow.json`）：
  spec / note / CONTEXT / question / ADR / workflow / GUIDE 体积与 description 字数，以及会话轮转阈值。
  体积字段在面板里以 **KB** 输入（1 KB = 1024 字节，存储仍是字节）。ADR 数量与追踪 Note
  行数不再限制；静态规则在 `prompts/limit.md`，具体值由脚本追加，启动时生成
  「篇幅限制」块拼在 `prompts/system.md` + `GUIDE.md` 之后注入。压缩与拆分规则统一
  由 `prompts/limit.md` 维护。
- 记忆维护由 **dream** 承担：`prompts/dream.md` 是投递给自动化任务的完整指令（每天 08:00 默认新建会话执行）；
  输入由 `nano_flow_dream` 工具的 `scan` 提供（实现是随包 `scripts/dream-scan.mjs`，
  按「Plan + 会话」记游标于 `$DSH_HOME/toolkit/nano-flow-dream.json`），只输出新 turn；
  dream 处理后跑 check 并 commit，成功后用同工具的 `mark` 推进游标。五 pass 写回领域文档与 `GUIDE.md`。互链写在页面文末
  `## 相关` 段（`- [链接](相对.md) — 原因`），check 校验目标与原因。
- 预设不挂载压缩插件。轮转挂在**宿主半**：用户每发一条**排队**消息（queue）时，先按会话 id
  找到存活会话，再用日志里最后一条 `agent-preset/selected` 判断它是否跑 Nano Flow（live header
  的 `agentPreset` 在恢复会话时不可靠），然后读 `tokenMeter.contextPressure` 的
  `projectedTokens ?? pressureTokens`。达到 `rotateAt × contextWindow` 时**不换会话**：把表面节点
  `nodes[1..]` 整体换成一条 seed 消息 —— 先追加 `compaction/prune` 记下遮蔽区间与逐节点计价，
  紧跟一条带 `surfaceOp.replace` 的 `user/message`，再 `sessions.flush()` 落盘。日志只追加不删，
  会话 id 不变，所以同一会话上的子 agent、后台 job 与 Plan 绑定原样存活，客户端不需要跟随跳转。
- seed 五段：固定首句、恢复当前 Plan（已绑定则注明「无需再 `nano_flow_bind`」）、只读报告
  `spec.md` 与 `notes_index.md`、自动 `nano_flow_check` 的结论、最末是上一轮模型输出的
  `<reset-last-output>` 块（保尾截断到 8 KB）。被遮蔽的旧历史不会回到模型视野，重启、fork、
  导出同样看不到；所以每轮结束前必须把检查点写回磁盘：spec 的进度与恢复入口、note 的 status / next_step。
- 两道闸：只在上一轮已 `turn/end` 后动表面（mid-turn 遮蔽会抽掉当前步要用的历史）；一次重置后
  必须已产出过新的 assistant 消息才允许再次重置，避免同一占用反复重置。轮转只能自动触发，
  没有手动命令。
- 轮转不写在预设行里：预设行读不到 `ctx.agent`（cordis 对服务属性做 inject 守卫），而根插件
  又不能声明 `agent` 依赖（根上下文里没有 agent）。`nano-flow-mount.json` 的 `stages` 记录每一步，
  挂载/轮转是否生效看这个文件即可。
- `nano-flow/scripts/check-domain.mjs` 是唯一校验与索引生成实现，`nano_flow_check` 用
  `process.execPath` 调用它，并把当前设置作为 `--limits` 传入。

**已删除的旧能力**

`nano_flow_read` / `nano_flow_write`、`notes.json` 与 notes DAG、`notes-guard` 的 fs/tools
收口、ready 面板与 `/api/toolkit/nano-flow-ready`、`story.md`、旧 `QUESTIONS.md` / `INDEX.md`、
`assets.lock.json`。文档改用普通文件工具读写；`nano_flow_check` 负责机器校验与索引。

**验证**

1. 重新构建并安装插件，重启宿主；新建会话时预设选择器出现"Nano Flow"。
2. 选中该预设：系统提示里出现 Nano Flow 规则；本轮首次请求的上下文中有一句
   `prompts/user.md`（UI 以 context 卡片显示，不显示为用户消息），后续每轮再追加一次。
3. 换一个预设：上述提示词、工具与 skill 全部消失。
4. 在空工作区让模型建 domain、plan、note：出现 `CONTEXT-MAP.md`、域文档骨架、`GUIDE.md` 空模板、
   `spec.md`、`notes_index.md`；`nano_flow_check` 通过并列出更新的索引。
5. 打开 toolkit 面板的"Nano Flow 设置"，改一个上限并保存；重启后值保持，下一次 check 生效。
6. 把轮转阈值调到很低（如 0.05），再发一条排队消息：会话 id 不变、GUI 历史仍在，模型按 seed
   开局只读 `spec.md` 与 `notes_index.md` 并报告进度；会话日志里恰好多出一条 `compaction/prune`
   与紧邻的 `surfaceOp.replace`，下一条请求的 `usage.totalTokens` 回落到 seed 规模；重置前起的
   子 agent 与后台 job 仍存活。
7. 挂载诊断：`$DSH_HOME/toolkit/nano-flow-mount.json` 的 `stages` 应同时有 `entry`
   (`via: preset`)、`apply`、`ready` 与 `rotation`；缺哪个就说明哪一步没生效。
8. 把一条 note 置 `blocked` 但不写 `reason`：`nano_flow_check` 报"缺少 reason"；补上后通过，
   spec 的状态与 `## 追踪 Note` 自动更新。
9. 在 nano-flow 会话里改一条未完成 note 的 `status`：输入框上方的 Note 面板默认展开、5s 内更新；
   hover 显示该 note 的 `description`，有 `reason`（阻塞）与 `next_step` 时各多一行；note 全部完成，或该会话没有绑定/绑定目录失效时面板消失。
10. 先在新会话调用 `nano_flow_bind`，再正常对话几轮（至少触发一次工具调用）：当前 Plan 目录出现
    `log.jsonl`，首行是本会话段头，其后每轮一行 `turn`（sessionId/turn/user/assistant/tools/usage/seq）。
    重启/重开会话后历史正常加载，会话日志里不再出现 `nano-flow/notes`。
11. 在同一会话用 `nano_flow_bind` 切到另一个 Plan：Note 看板立即换 Plan，后续轮次写入新 Plan 的
    `log.jsonl`；旧 Plan 的日志保留已写入的轮次，不再追加。

## 配置

全部字段可选;写在 profile 的 cordis 配置里,面板开关写在状态文件中(见下).

| 字段                        | 默认                              | 含义                                                   |
| --------------------------- | --------------------------------- | ------------------------------------------------------ |
| `watch`                     | `true`                            | 监听扫描根以感知目录变化                               |
| `watchUsePolling`           | `false`                           | 以轮询代替原生文件系统事件                             |
| `watchPollIntervalMs`       | `100`                             | 轮询探测间隔                                           |
| `watchStabilityThresholdMs` | `200`                             | 变更条目稳定窗口                                       |
| `includeUserRoots`          | `true`                            | 是否扫描用户 `.agents` 根                              |
| `agentsHome`                | `$DSH_AGENTS_HOME` \| `~/.agents` | 用户 agent 根                                          |
| `excludedDirs`              | 见源码                            | 额外剪除的目录名                                       |
| `extraRoots`                | `[]`                              | 以 `custom` 来源扫描的额外根                           |
| `stateFile`                 | `$DSH_HOME/toolkit/state.json`    | 工具开关与待删除会话的文件位置                         |
| `sessionsRoot`              | `$DSH_HOME/sessions`              | 会话日志根(只给启动清理旧版删除式撤回留下的遗留会话用) |

状态文件形状:

```json
{
  "version": 1,
  "tools": { "nested-skill": true, "undo-turn": true, "office-skills": false },
  "pendingDeletes": [],
  "pendingUnarchives": []
}
```

`pendingDeletes` 是"会话仍存活,推迟到下次启动再删"的原会话 id;`pendingUnarchives` 是日志已删,还等着从归档集合里去掉的 id.启动时依次处理并清空.
这两份清单只由**旧版的删除式撤回**产生;现在的就地撤回不写它们,启动清理保留下来给历史数据自愈.

启动时还会做一次清扫:归档集合里**既没有日志,也不存活**的 id 会被直接摘掉(历史上旧版本留下的占位由此自愈),有日志或仍存活的归档条目保持不动.

## 宿主路由

浏览器半通过连接服务的同源路由读写开关(`ctx.connection.fetch.register`,已鉴权):

| 路由                     | 方法 | 请求                                   | 响应                                               |
| ------------------------ | ---- | -------------------------------------- | -------------------------------------------------- |
| `/api/toolkit/state`     | GET  | -                                      | `{ tools: [{ id, title, description, enabled }] }` |
| `/api/toolkit/state`     | POST | `{ id, enabled }`                      | 同上(切换后的目录)                                 |
| `/api/toolkit/undo-turn` | GET  | `?sessionId=<id>`                      | `{ available, reason?, prompt? }`                  |
| `/api/toolkit/undo-turn` | POST | `{ sessionId, messageId?, boundary? }` | `{ boundary, seq, prompt }`                        |

`messageId`/`boundary` 是可选的确认锚点:与最后一轮的用户消息对不上时按 `no-previous-turn` 拒绝,避免客户端撤掉别的一轮.

错误体为 `{ error, message }`:`invalid-body`(400),`unknown-tool`(400),
`tool-disabled`(409),`no-previous-turn`(409),`session-not-live`(409),
`agent-busy`(409),`unsupported-host`(501).

## 兼容性

不钉宿主版本:DSH peers(`@deepseek-ai/dsh-fs`,`dsh-skill`,`dsh-home-paths`)只声明下限
`>=0.2.1-rc.3`,任何更新的宿主(预发布或稳定)都满足;没有 `engines.dsh`,因此 0.2.x 的
兼容性评估对每一版都通过.

客户端半的契约(slot 名,面板/按钮的 owner props,`uiWorkspace` 与 `conversation` 的入口,
平台模块表里的 `@deepseek-ai/dsh-client-ui-primitives`)按宿主 `0.2.1-rc.5` 的实装取证,
结构声明集中在 `src/client/contract.ts`;宿主升级后若形状漂移,会在真机验收暴露.

## 验证

1. 重启宿主后,左侧边栏出现 `toolkit` 行;点击打开面板,三个工具各有一个开关.
2. 关闭"嵌套 skill 发现"后新会话的 skill 目录里不再有嵌套 skill;重新打开后恢复.
3. 开启"移除 dsh 自带 office 技能"后新会话的 skill 目录里不再有 `office*`;
   `skill` 加载 `office-docx` 也拿不到内容;关闭开关后恢复.
4. 任意会话发一条消息,等它跑完,点"撤回"→ 确认:那一轮从对话里消失(会话 id 与会话行不变),
   输入框出现刚才那条原文,会话日志里多出一条 `system/message` 墓碑、表面最后一个节点就是它.
5. 会话正在跑一轮时按钮置灰;只剩一轮时同样置灰.

## 卸载

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop remove @kxh4892636/dsh-toolkit
```

## 开发

```powershell
pnpm --filter @kxh4892636/dsh-toolkit test
pnpm --filter @kxh4892636/dsh-toolkit check
pnpm --filter @kxh4892636/dsh-toolkit build
```

打包用 `pnpm pack`:`prepack` 是 `vp run --no-cache build`,先跑一次完整 `build`,所以
tarball 一定带 `dist/nano-flow/`.`pnpm pack` 的生命周期只有 `prepack` / `prepare` /
`postpack`,**不执行 `prepublishOnly`**--把构建挂在那里的写法会让本地打包静默带上陈旧
`dist`(缺 nano-flow 资产,装进去运行时 `locateAssetsRoot()` 直接抛错).要禁用 `vp run`
的缓存,flag 必须写在脚本名之前(`vp run --no-cache build`),写在后面会被转发给被调脚本.
该契约由 `src/packaging.test.ts` 守住.

`build` 分两步:`vp pack` 出宿主半 `dist/index.mjs` 与客户端半的 CJS 中间产物,
`scripts/wrap-client.mjs` 把后者包成宿主模块载体的形态(`window.__ModuleLoader__.load`),
校验它只 require 平台模块表里的裸说明符,并真正执行一次确认导出了 `inject` / `apply`.
`react`,`react-dom` 与 UI 基座必须保持外部--它们由宿主页面提供,自带一份会拆开 hook 上下文.
