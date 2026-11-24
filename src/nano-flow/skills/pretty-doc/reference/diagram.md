# 画板

只为流程、结构、状态、时序、时间线画图。表格或段落能说清的事，不画。

## 1. 出图

读 `<diagram-design-root>/SKILL.md`，按它的类型指南选图和排版。默认尺寸 `doc-inline`（960×600），detail 用 `balanced`，audience 跟随文档读者；节点超过 6 个再用 `doc-wide`（1280×720）。

配色不要用 diagram-design 的默认 paper / ink / coral，改用下面的 Lark 皮肤。把这份表当作当前图生效的皮肤，不要改安装目录里的 `style-guide.md`。字体源设为 `system`。

### Lark 皮肤

| 语义角色    | 值        | 用途             |
| ----------- | --------- | ---------------- |
| paper       | `#ffffff` | 画布、普通节点底 |
| paper-2     | `#f5f6f7` | 存储 / 次级底    |
| ink         | `#1f2329` | 主文字、强描边   |
| muted       | `#646a73` | 次文字、默认箭头 |
| soft        | `#8f959e` | 弱文字、辅助线   |
| rule        | `#dee0e3` | 细边框           |
| accent      | `#245bdb` | 唯一焦点，1-2 个 |
| accent-tint | `#f0f4ff` | 焦点节点底       |
| link        | `#245bdb` | 链接、HTTP 箭头  |

语义节点（对应 diagram-design 的 `focal` / `backend` / `store` / `external` / `input` / `optional` / `security`）：

| 类型        | fill      | stroke                |
| ----------- | --------- | --------------------- |
| 焦点        | `#f0f4ff` | `#245bdb`             |
| 普通        | `#ffffff` | `#dee0e3`             |
| 存储 / 状态 | `#f5f6f7` | `#dee0e3`             |
| 外部 / 云   | `#f6f1fe` | `#ad82f7`             |
| 输入 / 用户 | `#f0fbef` | `#8ee085`             |
| 可选 / 异步 | `#ffffff` | `#dee0e3`，虚线 `4,3` |
| 安全 / 边界 | `#fff5eb` | `#ffba6b`，虚线 `4,4` |
| 结果 / 收益 | `#f0fbef` | `#8ee085`             |
| 风险 / 反例 | `#fef1f1` | `#f98e8b`             |

规则：

- 焦点色最多 1-2 个；其余节点用白 / 浅灰，或按语义用浅蓝、浅绿、浅紫。不要给每个节点都上色。
- 白底，不点阵，不加阴影，圆角 ≤ 8。
- 需要区分多个系列时，按蓝 `#245bdb`、绿 `#2ea121`、橙 `#de7802`、紫 `#6425d0`、红 `#d83931` 的顺序取；只用于数据图。
- 字号：节点名 16 / 600，子标签 12 / 400，箭头标签 11 / 400，eyebrow 10 / 500；`doc-wide` 时把节点名提到 20、子标签 14。飞书画板会把文字统一成 Noto Sans SC，别靠 serif / mono 区分层级，用字号、字重、颜色。
- 文字留 8px 内边距；按 CJK 1em、Latin 0.6em 估宽，宁可把框留大。

### 画板约束

- 文字必须用 `<text>`，不要转成路径。
- 连线用正交折线；箭头可以用 marker。标签下垫一块与背景同色的矩形，别让线穿字。
- 不用 `<pattern>`、`<clipPath>`、`<mask>`、非阴影 `<filter>`。转换脚本会删，但最好一开始就不画。
- 画布只留内容 + 40px 留白：960×600 是排版框，不是交付尺寸；导出后把 `viewBox` 收到内容边界（或用 diagram-design 的 `fit`）。空白会原样变成文档里的空白。
- 一图 ≤ 9 个节点、≤ 12 条连线；超了就拆成两张。

## 2. 导出与转换

```bash
python3 <diagram-design-root>/scripts/export_svg.py diagram.html diagram.svg --system-fonts
python3 <pretty-doc-root>/scripts/larkify_svg.py diagram.svg diagram.lark.svg --palette <pretty-doc-root>/assets/lark-palette.json
```

`larkify_svg.py` 做四件事：

1. 把 `<style>` 和 class 里的 fill / stroke / 字体内联成属性。飞书画板不执行 CSS，不内联就会变成黑块。
2. 把 diagram-design 的默认色映射到 Lark 色（`assets/lark-palette.json`）。
3. 删 `<pattern>` / `<clipPath>` / `<mask>` / `<filter>`，把全屏点阵底换成白底。
4. 去掉 class / style / 外部引用，留下一个可嵌入的 `<svg>`。

转换后检查：以 `<svg` 开头、有 `viewBox`、没有 `<style>` / `class=` / `<pattern` / `http` 外链。

## 3. 嵌入

```xml
<whiteboard type="svg" path="@./diagram.lark.svg"></whiteboard>
```

`path` 相对命令的 CWD。先 `cd` 到 `.temp/pretty-doc-<slug>/`，再执行 `lark-cli docs +create --doc-format xml --content "@./doc.xml"`。

## 4. 回读

创建后从返回值或 `docs +fetch` 拿画板 token：

```bash
lark-cli docs +fetch --doc <url> --doc-format xml --detail with-ids
lark-cli whiteboard +export --whiteboard-token <token> --output-type preview --output ./preview.jpg
```

看预览图里的四件事：

- 文字是否被截断；截断就加宽节点或缩短标签。
- 箭头是否完整；丢了就检查 marker 是否还在 `<defs>`。
- 是否出现黑块；出现说明 CSS 没内联，重跑转换。
- 强调色是否 ≤ 2 个；超过就收回焦点。

预览图是方形画布，图只占上半部分；以文档里的实际渲染为准，不要按预览的留白改图。

要改已插入的画板：

```bash
lark-cli docs +update --doc <url> --command block_replace --block-id <block_id> \
  --content '<whiteboard type="svg" path="@./diagram.lark.svg"></whiteboard>'
```

## 常见问题

| 现象                     | 原因                               | 处理                                       |
| ------------------------ | ---------------------------------- | ------------------------------------------ |
| 画板里全是黑块、文字消失 | 画板不认 `<style>` / class         | 跑 `larkify_svg.py`，确认输出没有 `class=` |
| 字体和设计稿不一致       | 画板统一用 Noto Sans SC            | 正常；靠字号 / 字重 / 颜色分层             |
| 点阵、阴影没了           | 画板不支持 pattern / 非阴影 filter | 正常；转换脚本会删                         |
| 文字挤在一起             | 画板按内容重排文字                 | 加宽节点、缩短标签、留 8px 内边距          |
| 预览四周大片空白         | 预览是方形画布                     | 正常；看文档内渲染                         |

## 相关

- [DocxXML 版式](docx-xml.md) — 画板在文档里的位置和上下文
