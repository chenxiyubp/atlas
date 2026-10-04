---
name: dev-standards
description: "在修改 open-claude-code 的 system prompt、工具定义、CLAUDE.md、技能或 Windows 兼容行为时使用，帮助确定规则、接口说明、按需参考文档与可执行检查的边界。"
---

# open-claude-code 开发规范

只写**判断依据**。能从代码读出来的事实在 `CLAUDE.md`，流程与命令在 `CONTRIBUTING.md`。

## 总原则：少即是多

新增任何"规则"前先自问：**这条是在补充模型不知道的事实，还是在替模型做它自己会做的判断？** 后者删掉。过长的 CLAUDE.md 的真实代价不是 token，是**重要规则被淹没后被忽略**。

模型相关的具体调整方向（effort 与 thinking、评审措辞、响应长度、任务边界）见 [model-notes.md](model-notes.md)；应用前确认实际模型与路由。

## 四个面的落点

| 面 | 放什么 | 细则 |
| --- | --- | --- |
| system prompt | 产品身份与环境事实——模型无法自己得知的 | [prompts-and-tools.md](prompts-and-tools.md) |
| 工具定义 | 用参数与 schema 表达能力，不用示例约束 | [prompts-and-tools.md](prompts-and-tools.md) |
| CLAUDE.md | 仓库概览 + gotcha，其余只留指针 | [docs-and-skills.md](docs-and-skills.md) |
| skills | 团队观点与实践，渐进式披露 | [docs-and-skills.md](docs-and-skills.md) |

## 给 Claude 可验证的检查

**给 Claude 一个它自己能跑的检查**，否则"看起来完成了"就是唯一信号。本仓库现成的：`bun run precheck`、`bun run check:cycles`、`bun test <path>`、`scripts/dump-prompt.ts` 前后对比。写任务描述时把验收条件写成**能跑的东西**，要求出示命令与输出。

## 参照物优先于文字描述

要复现某个形态时给**高保真参照**——现有实现、测试、快照——而不是散文规格："新增 facade 照抄 `slowOperations.ts`"、"新增 provider 照抄 `specs.ts` 的表项"比十行规格准确得多。

## 跨平台：路径一律正斜杠

官方 skill 规范：**永远用正斜杠**，即使在 Windows 上。本仓库更强的一条：**解析**路径时必须同时接受两种分隔符（`split(/[/\\]/)`），因为 `join()`/`dirname()` 在 Windows 上产出反斜杠——这里踩过坑（plugin 命名空间、版本解析）。Windows 不变式在 `CLAUDE.md` 的路径与隔离一节。

## 反模式对照

| 旧做法 | 现在 |
| --- | --- |
| 没有任务依据的流程性护栏 | 按风险陈述边界，保留权限、安全、隔离和验收契约 |
| 给工具写用法示例 | 把能力表达进参数与 schema |
| 同一条指令多处重复 | 单一权威位置，其余引用 |
| 知识堆在 CLAUDE.md | gotcha 留下，其余进 skill / `docs/` |
| 用散文描述期望产物 | 给代码 / 测试 / 快照当参照 |
| 无条件重复叮嘱复核 | 给出可执行检查与完成证据 |
| 无脑派子 agent | 并行或需要隔离上下文时才派 |

## 参考

- [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
