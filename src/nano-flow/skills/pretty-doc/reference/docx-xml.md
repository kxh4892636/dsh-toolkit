# DocxXML 版式

语法权威是 lark-cli 的 `lark-doc-xml.md`。写之前先读：

```bash
lark-cli skills read lark-doc/references/lark-doc-xml.md
```

本文只给 pretty-doc 的默认骨架和复制片段；两者冲突时以 lark-cli 的语法文档为准。

## 骨架

```xml
<title>把一次改造写清楚</title>
<callout emoji="📌" background-color="light-blue" border-color="blue">
  <p><b>一句话总结：</b>把首页加载从 3.2 秒压到 1.1 秒。</p>
  <blockquote><p><b>关键思路：</b>预请求、缓存、图片懒加载，按顺序上。</p></blockquote>
  <p>落地顺序：</p>
  <ol>
    <li seq="auto"><b>量基线</b></li>
    <li seq="auto"><b>拆瓶颈</b></li>
    <li seq="auto"><b>改链路</b></li>
    <li seq="auto"><b>看结果</b></li>
  </ol>
</callout>

<p></p><p></p>
<h1>背景 | Status Quo</h1>
<blockquote><p>用户抱怨首页慢，但没人说得清慢在哪。</p></blockquote>
<p>先补监控：首屏耗时、接口耗时、图片体积，按天记录。</p>

<p></p><p></p>
<h1>三个动作</h1>
<blockquote><p>把等待拆成三段，一段一段压。</p></blockquote>
...
```

- `<title>` 唯一且在开头；正文标题从 `<h1>` 开始，层级连续。
- 每个 h1 前放两个空段 `<p></p><p></p>`；飞书不渲染源码空行。
- 一、二、三级标题默认黑色；不用 `<hr/>` 切章节。
- 长文改用 h1 部 / h2 节 / h3 点，见「长文层级」。
- 标题不编号；确有顺序才手写 `1.` 前缀。

## 组件

### TLDR

```xml
<callout emoji="📌" background-color="light-blue" border-color="blue">
  <p><b>一句话总结：</b>本文把 X 从 A 做到 B。</p>
  <blockquote><p><b>关键思路：</b>用 Y 解决 Z。</p></blockquote>
  <p>落地顺序：</p>
  <ol>
    <li seq="auto"><b>量基线</b></li>
    <li seq="auto"><b>拆瓶颈</b></li>
    <li seq="auto"><b>改链路</b></li>
  </ol>
</callout>
```

### 多观点 callout

一个主题下的 3-5 个观点放在同一个 callout 里：每个观点一行加粗标签 + 一句解释，解释用嵌套 blockquote。

```xml
<callout emoji="✨" background-color="light-yellow" border-color="yellow">
  <p><b>角色转换：</b>全栈首先是视角的转换，不是多写一端代码。</p>
  <blockquote><p>从前端到全栈，要围绕业务目标看需求全流程，避免只看单节点效率。</p></blockquote>
  <p><b>能力迁移：</b>辅栈能力提升快于单栈，但前期有学习成本。</p>
  <blockquote><p>前端全栈前期主要成本在平台学习、链路理解和环境调试，短期可能负提效。</p></blockquote>
  <p><b>规模复制：</b>工程对 AI 越友好，全栈越容易复制。</p>
  <blockquote><p>仓库结构、服务依赖、AGENTS.md、Skills 越完整，AI 越容易找到正确代码。</p></blockquote>
</callout>
```

- 3-5 个观点；一个 callout 只放一个主题，超过 5 个拆成两个。
- 每个观点先给判断，再给解释；解释比判断长一点，不要反过来。
- 算一个 callout；全文 callout 总数仍 ≤ 6。
- 用 `light-yellow` 放洞察，`light-purple` 放结论；不要为了凑色而换色。

### 双栏

```xml
<grid>
  <column width-ratio="0.5">
    <callout emoji="🔑" background-color="light-blue" border-color="blue">
      <p><b>方向 A</b></p>
      <blockquote><p>一句引导</p></blockquote>
      <ul>
        <li><b>要点 1：</b>说明</li>
        <li><b>要点 2：</b>说明</li>
      </ul>
    </callout>
  </column>
  <column width-ratio="0.5">
    <callout emoji="⚡" background-color="light-purple" border-color="purple">
      <p><b>方向 B</b></p>
      <blockquote><p>一句引导</p></blockquote>
      <ul>
        <li><b>要点 1：</b>说明</li>
        <li><b>要点 2：</b>说明</li>
      </ul>
    </callout>
  </column>
</grid>
```

两列用 0.5 / 0.5；三列用 0.33 / 0.34 / 0.33。相邻 callout 换色。各列差异只在文字、没有并列结构时，用段落。

### 表格

```xml
<table>
  <colgroup><col width="360"/><col width="200"/><col width="200"/><col width="240"/></colgroup>
  <thead>
    <tr>
      <th background-color="light-gray"><p><b>指标</b></p></th>
      <th background-color="light-gray"><p><b>改造前</b></p></th>
      <th background-color="light-gray"><p><b>改造后</b></p></th>
      <th background-color="light-gray"><p><b>变化</b></p></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><p>首屏耗时</p></td>
      <td><p>3.2s</p></td>
      <td><p><b><span text-color="green">1.1s</span></b></p></td>
      <td><p><span text-color="green">-66%</span></p></td>
    </tr>
  </tbody>
</table>
```

列宽合计约 1000；表头 `light-gray`；关键数字绿色加粗。3 个以上维度用表，不要塞进 grid。

### 状态 callout

```xml
<callout emoji="💡" background-color="light-yellow" border-color="yellow">
  <p><b>洞察：</b>真正拖慢首屏的不是接口数量，是串行等待。</p>
</callout>

<callout emoji="⭐" background-color="light-green" border-color="green">
  <p><b>结果：</b>上线一周，首屏 P95 下降 <b><span text-color="green">66%</span></b>。</p>
</callout>

<callout emoji="❗" background-color="light-orange" border-color="orange">
  <p><b>注意：</b>预请求要和服务端限流一起上，否则高峰期会打满接口。</p>
</callout>
```

### 画板

```xml
<whiteboard type="svg" path="@./diagram.lark.svg"></whiteboard>
```

画板是顶层块，不要塞进 callout；图怎么来见 [diagram.md](diagram.md)。`path` 相对命令的 CWD，先 `cd` 到工作目录再执行。

### 段落与列表

```xml
<p>长文件治理有三个麻烦：读得慢、改不动、编译也慢。</p>

<ul>
  <li><b>读得慢：</b>跨模块调用多，新人一天看不完一条链路。</li>
  <li><b>改不动：</b>一次改动容易带出回归，评审只能靠猜。</li>
  <li><b>编译慢：</b>增量编译从 20 秒涨到 2 分钟。</li>
</ul>
```

单段文字最多 144 字，最好 89 字以内；列表首词加粗做标签，但别每条都一个句式。

### 结尾

```xml
<p></p><p></p>
<h1>下一步</h1>
<p>把监控面板交给值班同学，每周看一次首屏 P95；连续两周超过 1.5 秒就回查。</p>
```

结尾给一个具体动作：谁、做什么、什么时候。没有下一步就不写。

## 长文层级

长文（约 1500 字以上，或内容明显分成几部）用三级结构：

```xml
<h1>流程与机制</h1>
<blockquote><p>从目标、分层到培养，一条条拆。</p></blockquote>

<h2>目标制定</h2>
<blockquote><p>先定交付、业务、人才三个口径。</p></blockquote>
<p>...</p>

<h3>指标建议</h3>
<p>...</p>

<h2>业务如何分层</h2>
<blockquote><p>先按技术复杂度分，再按需求复杂度分。</p></blockquote>
<p>...</p>
```

- `h1` 分部（2-4 个），`h2` 分节（每部 2-4 个），`h3` 分点（每节 1-3 个）。
- `h2` 用名词短语或读者问题都可以；「目标制定」和「目标怎么制定？」都行，不强制问句。
- 层级连续：h1 → h2 → h3，不跳级；h4 只在确有必要时用。
- 标题默认黑色，不套 `<span text-color>`；h1 前两个空段，h2/h3 前按需一个空段。
- 每个 h2 下先用一句 blockquote 交代这节要回答什么，再展开。

## 配色

| 用途            | emoji | background-color | border-color |
| --------------- | ----- | ---------------- | ------------ |
| TLDR / 关键论点 | 📌    | light-blue       | blue         |
| 洞察 / 启示     | 💡    | light-yellow     | yellow       |
| 结果 / 收益     | ⭐ ✅ | light-green      | green        |
| 注意 / 风险     | ❗ ⚠️ | light-orange     | orange       |
| 反例 / 高危     | ❌    | light-red        | red          |
| 结论 / 推进     | 🚀    | light-purple     | purple       |
| 数据高亮        | 📊    | light-green      | green        |

- 主色 light-blue / light-purple / light-green 占 70%-85%；点缀 light-orange / light-yellow / light-red 占 15%-30%；light-gray ≤ 5%。
- `background-color` 和 `border-color` 成对写；只写一个会被服务端补齐。
- 同一节奏块（相邻 grid 列、连续 callout）必须换色；不要连续 3 个浅蓝。
- 文字色只标短语：`<span text-color="green">+35%</span>`；正文大面积着色会抢重点。

## 硬约束

- callout 子块只能是 `p` / `ol` / `ul` / `checkbox` / `blockquote`；不能塞 `table` / `grid` / `whiteboard` / `img` / `pre`。
- grid 各列 `width-ratio` 之和为 1；两列 callout 必须不同色。
- 表格列宽合计约 1000；合并单元格只在起始格写 `rowspan` / `colspan`。
- 标题层级连续，不跳级；长文 h1 → h2 → h3，h2 可用名词短语或问句。
- 文本转义 `&`、`<`、`>`；换行用 `<br/>`；属性必须带引号。
- 不用 Markdown：`**`、`#`、`>`、`- `、`| 表格`、代码围栏都不会被解析。
- 颜色名是 `gray`，不是 `grey`；emoji 直接写字符，不写 `bulb` 这类 shortcode。

## 反例

```xml
<!-- 错：Markdown 不解析 -->
<p>**重点**：这样写不会加粗。</p>

<!-- 错：callout 里塞表格 -->
<callout emoji="💡" background-color="light-blue" border-color="blue">
  <table>...</table>
</callout>

<!-- 错：grid 用错属性 -->
<grid cols="2"><column width="50">...</column></grid>

<!-- 错：只写一个颜色 -->
<callout emoji="💡" background-color="light-blue"><p>...</p></callout>
```
