---
name: pretty-doc
description: 把素材写成排版美观的飞书文档；按 TLDR → 分节 → 行动组织 DocxXML，用 callout、分栏、表格控节奏，画板由 diagram-design 产出 SVG 并转成画板安全格式，最后用 lark-cli 创建和回读。
disable-model-invocation: true
---

# Pretty Doc

把用户给的素材写成一篇能直接发出去的飞书文档。默认新建文档，不动已有文档。这是手调技能，只在用户点名时运行。

## 循环

1. **定读者与结论**：一句话写清读者是谁、要做什么决定，以及全文结论。素材不足先问，不编数据。
2. **搭骨架**：标题 + TLDR + 3-5 个一级节 + 下一步。长文或目标不清时，先把骨架给用户看一眼。
3. **写正文**：在 `.temp/pretty-doc-<slug>/doc.xml` 写 DocxXML。配方见 [reference/docx-xml.md](reference/docx-xml.md)，文风照下一节。
4. **配画板**：只为流程、结构、状态、时序画图。按 [reference/diagram.md](reference/diagram.md) 走：diagram-design 出 HTML → 导出 SVG → `scripts/larkify_svg.py` 转成画板安全格式 → `<whiteboard type="svg" path="@./x.svg"></whiteboard>`。
5. **校验**：`lark-cli docs +script --command parse --content "@./doc.xml" --format json` 必须 `passed`；再过一遍自查清单。
6. **创建**：`lark-cli docs +create --doc-format xml --content "@./doc.xml"`，记下 URL。覆盖已有文档前先征得同意。
7. **回读**：`docs +fetch` 看结构；有画板就逐个 `whiteboard +export` 出预览图，检查文字、箭头、配色；不对就改 SVG 后 `block_replace`。
8. **交付**：给链接、一句话说明写了什么、还有哪些没确认。

## 文风

- 先结论，后解释；一段一个意思，单段文字最多 144 字，最好 89 字以内。
- 用具体动词、名词和数字。「提升明显」改成「从 3.2s 降到 1.1s」。
- 标题用精准名词短语或读者问题；不用口号、双关、破折号副标题。
- 每节先用 1-2 句 blockquote 交代这节要回答什么。
- 列表首词加粗做标签，但别每条一个模子；2-3 条可以用完整句子。
- 比喻全文 ≤ 1 处；排比 ≤ 4 处；形容词要有数据撑腰。
- 用「我们」讲做过的事，用「你」讲要做的事；不确定就写「暂按此假设」。
- 结尾给一个具体动作：谁、做什么、什么时候。
- 删掉不影响读者判断和行动的句子。

## 版式

- 标题：`<h1>…</h1>`，默认黑色；层级连续，不跳级。
- TLDR：顶部一个浅蓝 callout，写一句话总结 + 关键思路 + 3-4 步落地顺序。
- 分节：每节一个 h1，前面放两个空段撑留白；节内用引导引用、段落、列表、表格或画板。
- 重点：callout 只放真正的重点；全文 ≤ 6 个，同节连续 callout 换色。
- 并列：2-3 个短块用 `<grid>`；3 个以上维度用表格。
- 数据：表头 `light-gray`，关键数字绿色加粗。
- 画板：一图一个观点，全文 1-2 张；9 个节点、12 条连线封顶。

完整标签、配色和反例见 [reference/docx-xml.md](reference/docx-xml.md)。

## 自查

- 读者能在 30 秒内找到结论和下一步。
- 每个 callout 都在承载判断，不是装饰。
- 表格列宽合计约 1000，grid 的 `width-ratio` 合计 1。
- 没有 Markdown 语法（`**`、`#`、`- `、`| 表格`）。
- `&`、`<`、`>` 已转义；`<title>` 唯一且在开头。
- 画板 SVG 以 `<svg` 开头、带 `viewBox`，没有外部图片、脚本、字体。
- 画板预览里文字没被截断，箭头没丢，强调色不超过 2 个。

## 边界

- 只写用户给的材料；缺数据就标「待补」，不猜。
- 默认新建文档；覆盖已有文档、改别人的文档前先问。
- lark-cli 未登录或不可用时停下，说清缺什么；不降级成 Markdown。
- 画板是 SVG 画板；Mermaid 只在用户明确要时用。
