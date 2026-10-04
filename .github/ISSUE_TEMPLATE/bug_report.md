---
name: Bug 报告
about: 报告一个可复现的 bug
title: "bug: "
labels: ["bug"]
assignees: []
---

## 发帖前必读

- [ ] 我已经搜索过 [现有 Issues](https://github.com/sweetcornna/atlas/issues)，没有找到重复。
- [ ] 我的检出**跟到了 `main` 的最新提交** —— 本仓库不发布版本、不打 tag，判据是 commit 不是版本号。
- [ ] 我已经阅读过 [README](https://github.com/sweetcornna/atlas) 和相关文档。
- [ ] 这**不是**安全问题。安全问题请走 [`SECURITY.md`](https://github.com/sweetcornna/atlas/blob/main/SECURITY.md) 的私密通道，不要开公开 issue。

**未完成以上检查的 Issue 将被直接关闭。**

---

## 运行环境

| 项目| 值|
|---|---|
| 操作系统| 例如 macOS 15.4、Ubuntu 24.04|
| 架构| 例如 x86_64 / aarch64|
| Bun 版本| `bun --version` 的输出（要求 ≥ 1.3.11）|
| 检出 commit| `git rev-parse --short HEAD` 的输出|
| 运行形态| 本地 CLI / 单节点常驻（`qm resident`）/ 多节点 + 控制台（`qm console`）|
| 模型与 provider| 例如 claude-opus-5 · firstParty，或第三方端点|

## 复现步骤

1.
2.
3.

## 期望行为

<!-- 应该发生什么？ -->

## 实际行为

<!-- 实际发生了什么？如有必要可附截图。 -->

## 相关日志

<!-- 粘贴终端输出或错误信息，请使用 triple backticks 代码块。 -->

```text
```

## 补充信息

<!-- 其他上下文 — 配置、环境变量、尝试过的 workaround 等。 -->
