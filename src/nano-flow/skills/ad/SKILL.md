---
name: ad
description: 执行用户输入使用；交给多个 subagent 并行执行，主会话只做拆分与汇总。
disable-model-invocation: true
---

主会话只做拆分与汇总, 执行段交给 subagent 并行执行, 不堵塞主会话，读写操作;
