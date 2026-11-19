---
name: backup-plan
description: 按整体内容重命名当前 Plan 后归档；reference 还是 archived 给建议、由用户定。
disable-model-invocation: true
---

当前 Plan 根据整体内容进行重命名，重命名为进行归档。归到 `reference` 还是 `archived` 不预设：先给建议和理由，用户选哪个就归哪个。

1. 读当前绑定 Plan 的 `spec.md` 与全部 note，用一句话概括这段工作在做什么，取其中能当目录名的短语。
2. 目录新名：`<原日期>-<内容概括>`。日期用原目录名的前缀，概括用中文短句；note 与 spec 的正文一个字都不改。
3. 给出归档目标建议：
   - `reference`：note 全部 completed、结论以后还会被查（这种情况推荐 `reference`）。
   - `archived`：计划废弃、结论已被取代或与现状冲突（这种情况推荐 `archived`）。
     每条理由一句话，引 note 或 spec 里的证据，不空说。
4. 把「新目录名 + 建议目标 + 理由」报给用户，等用户选 `reference` 或 `archived`；用户改主意就按用户的来。
5. 有领域文档链接到旧目录时一并改（`grep -r 旧目录名 .agents`），别留死链。
6. 把整个目录移到 `plans/<用户选定的 lifecycle>/`。
7. 跑一次 `nano_flow_check`（只校验这个 Plan 所属的域），再把当前会话 `nano_flow_bind` 到新路径，`lifecycle` 用用户选定的那个。
8. 报告原目录名、新目录名、归档目标与 note 数。不要改任何 note 的状态。
