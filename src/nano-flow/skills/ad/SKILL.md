---
name: ad
description: 执行用户输入使用；交给多个 subagent 并行执行，主会话只做拆分与汇总。
---

主会话只做拆分与汇总, 执行段交给 subagent 并行执行, 不堵塞主会话，读写操作;
代码任务 `/ponytail skill` 和 `/code-spec skill` 进行代码实现，实现完成后 `/ponytail-review skill` 进行代码审查并自动修复，最后 commit；
