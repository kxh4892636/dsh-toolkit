---
name: backup-plan
description: 把当前 Plan 按整体内容重命名并归档；只能由用户手动调用。
disable-model-invocation: true
---

当前 Plan 根据整体内容进行重命名，重命名为进行归档。

1. 读当前绑定 Plan 的 `spec.md` 与全部 note，用一句话概括这段工作在做什么，取其中能当目录名的短语。
2. 目录改名：`<原日期>-<内容概括>`。日期用原目录名的前缀，概括用中文短句；note 与 spec 的正文一个字都不改。
3. 有领域文档链接到旧目录时一并改（`grep -r 旧目录名 .agents`），别留死链。
4. 把整个目录移到 `plans/archived/`。
5. 跑一次 `nano_flow_check`（只校验这个 Plan 所属的域），再把当前会话 `nano_flow_bind` 到新路径，`lifecycle` 用 `archived`。
6. 报告原目录名、新目录名与 note 数。不要改任何 note 的状态。
