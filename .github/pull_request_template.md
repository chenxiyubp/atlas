<!--
标题请用 Conventional Commits 格式：<type>: <描述>
常见 type：feat / fix / docs / chore / refactor / perf / test
-->

## 这个 PR 做了什么

<!-- 一两句话说明改动与动机。行为有变化的，写清变化前后。 -->

## 本 PR 修复的边界问题对应哪条用例

<!--
roadmap P0.4 必填项（为 AC-8 流程约束预埋）。
若本 PR 修复了某个边界/健壮性问题，写清它对应哪条用例（用例 ID 或测试文件:用例名），
说明「先写出会红的测试再让它变绿」。无边界修复则填 N/A。
-->

N/A

## 提交前自查

- [ ] `bun run precheck` 零错误（typecheck + lint fix + 全量测试，快速反馈）
- [ ] 推送/发 PR 前已跑 `bun run verify`（近 CI 门禁的只读式全量检查，含 cycles/unused/bundle）——`precheck` 过不等于 CI 过，差集见 [`CLAUDE.md`](../CLAUDE.md) §3
- [ ] 一件事一个提交；重构与行为改动分开提交，提交信息符合 Conventional Commits
- [ ] 走 PR + 评审，未直推 `main`
- [ ] 改动有测试覆盖；修 bug 的先写出会红的测试，再让它变绿
- [ ] 碰了路径 / 配置目录 / 安装卸载逻辑的，复查过 [`CLAUDE.md`](../CLAUDE.md) 的「路径与隔离不变式」——所有路径都从 `src/config/paths.ts` 派生，没有新增 `homedir() + '.claude'` 这类字面量拼接

## 验证方式

<!-- 贴实际跑过的命令与结果摘要。"应该没问题"不算验证。 -->
