<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @qianmo/handoff —— 本地—云端接力的纯逻辑核心

**一句话定位**：接力清单的校验、影子提交（不动用户的 HEAD / index / stash / 工作区文件）、会话文件的单文件提交、中枢的追加式接力台账。**纯逻辑**：不依赖 occ 运行时，不联网，不拼任何家目录路径，唯一会启动的子进程是 `git`。

| 项 | 指针 |
| --- | --- |
| 任务包 | `docs/dev/handoff-p17-plan.md` **§2 P17.4**「新包」表；清单、引用约定、台账状态见同文 **§1** |
| 上位设计 | `docs/dev/handoff-m1.md` **§5**（同步）、**§8**（安全） |
| 协议真源 | 清单与结果的整体上限取自 `@qianmo/protocol` 的 `LIMITS.maxMessageBytes`（各取 1/16），本包不另写协议数值；节点名用 `isValidSegment` 校验 |
| 依赖 | `@qianmo/protocol`；`@open-claude-code/tool-runtime` **只用 `secretScanner.js` 这一个子路径**（它只依赖同包的 `stringUtils`，不会带进运行时） |
| 不在本包 | `qm handoff` 各子命令、MCP 服务、中枢 API 与派发、节点桥、SSH 闸门、审计事件——都在别处，基于本包实现 |

## 1. 模块

| 文件 | 职责 |
| --- | --- |
| `src/manifest.ts` | 接力清单类型与校验；`refs/qianmo/...` 三类引用的构造与解析；`task.result.content` 的 JSON 编解码 |
| `src/shadow.ts` | 影子提交 `shadowCommit`，以及只算树不提交的 `shadowTree`（AC-H1 核对用） |
| `src/session.ts` | 会话文件 → 单文件树 → 提交（父为上一次的会话提交） |
| `src/ledger.ts` | 追加式 NDJSON 台账、状态机、重放、同节点互斥 |
| `src/git.ts` | 内部：跑 `git` 的唯一入口（参数向量、不经 shell、剥掉重定向用的环境变量） |

## 2. 对外 API

读 `src/index.ts`。下一步写 CLI / 中枢 / 节点桥要用的是这些：

```ts
// 清单与结果
validateManifest(value: unknown): ValidationResult<HandoffManifest>
parseManifest(text: string): ValidationResult<HandoffManifest>        // 先查字节数再 JSON.parse
validateResult(value: unknown): ValidationResult<HandoffResult>
encodeResultContent(result: HandoffResult): string                    // 不合法则抛 HandoffValidationError
decodeResultContent(content: string): ValidationResult<HandoffResult>
wipRef(device, branch) / sessionRef(device, sessionId) / taskBranch(taskId) / taskRef(taskId)
parseQianmoRef(ref: unknown): QianmoRef | null                        // 只认 wip / session / task 三类

// 影子提交
shadowCommit({ cwd, message?, maxFileBytes? }): Promise<ShadowCommit>
shadowTree({ cwd }): Promise<ShadowTree>
// ShadowTree  = { root, head: string|null, branch: string|null, tree, excluded }
// ShadowCommit = ShadowTree & { commit, changed, submodules }
// 拒绝时抛 SecretFoundError（findings: {path, matches}[]）或 OversizedFileError（files: {path, bytes}[]）

// 会话
sessionCommit({ cwd, file, name?, parent?, message? }): Promise<{ commit, tree, blob, name }>

// 台账
HandoffLedger.open(path, { now? }): HandoffLedger                     // 文件不存在即空台账；损坏抛 corrupt
ledger.accept(taskId, manifest) / dispatch(taskId, node) / start(taskId)
      / complete(taskId, result) / fail(taskId, reason) / markReturned(taskId)
ledger.get(taskId) / list() / activeOn(node) / tornTail / close()
replayLedger(content: Buffer | string): LedgerReplay                  // 纯函数，只读
```

`git` 子进程失败抛 `HandoffGitError`（`args`、`exitCode`、`stderr`）；台账错误抛 `HandoffLedgerError`，`code` 为 `unknown_task` / `duplicate_task` / `illegal_transition` / `node_busy` / `invalid_input` / `corrupt`（`corrupt` 带 `line`）。

## 3. 不变式

1. **影子提交不改用户的 HEAD、index、ref、stash、工作区文件。**全程用临时目录里的私有 `GIT_INDEX_FILE`，用完删除；只用 plumbing（`read-tree` / `add` / `diff-index` / `cat-file` / `write-tree` / `commit-tree`）；仓库里只会多出对象，不建 ref——调用方直接推 `<sha>:refs/qianmo/...`。用例逐字节比对 `.git/index`，并比对 HEAD、全部 ref、`stash list` 与每个工作区文件。
2. **不触发用户的 hook。**plumbing 本身不跑提交类 hook，但写 index 会触发 `post-index-change`、刷新 index 会调 `core.fsmonitor`；每条命令都带 `-c core.hooksPath=<空目录> -c core.fsmonitor=false`。用例装了四个 hook 并带正对照。
3. **不依赖用户的 git 配置做身份。**作者与提交者固定为 `HANDOFF_GIT_IDENTITY`，经 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 给出；`commit-tree` 带 `--no-gpg-sign`。
4. **不被父进程的 git 环境带偏。**`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY` 等重定向变量在启动 `git` 前剥掉（`qm handoff sync` 会被别的工具的 hook 拉起）。
5. **扫的就是要推的。**秘密扫描读的是 `git add` 刚写入的 blob，而不是磁盘文件；命中即中止，报文件与规则 id，不带匹配原文。读不全对象时按失败处理，不当作扫过。
6. **清单与结果是封闭的。**白名单之外的字段（含 JSON 里的 `__proto__`）拒绝；校验通过后逐字段重建对象返回。
7. **台账先落盘再生效。**每条迁移先对内存状态校验，再 `write` + `fsync`，最后才更新内存。

## 4. 排除、秘密、子模块与超大文件

- **排除**：`.gitignore`（含 `.git/info/exclude` 与用户的 `core.excludesFile`）照常生效；在此之上叠加导出的 `SECRET_PATH_PATTERNS`（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.netrc`、`.git-credentials` 等，任意深度、大小写不敏感）。**有意不用 `id_*`**：它会把 `id_generator.ts` 这类源文件一并吞掉，而被排除的文件云端是看不到的。被排除的未跟踪文件经 `excluded` 返回，供调用方提示用户。已跟踪的匹配文件保留 HEAD 版本（已在历史里，不重传当前内容，也不记成删除）。
- **秘密**：对相对 HEAD 新增、修改、类型变化的文件跑 `scanForSecrets`（gitleaks 高置信规则子集）；命中抛 `SecretFoundError`。被忽略的文件不进影子，也就不扫。
- **子模块**：只带 gitlink 指针（与 `git add` 的行为一致），子模块内部的未提交改动不随接力走；未登记的嵌套仓库同样记成 gitlink。变化了的 gitlink 经 `submodules` 报出，不扫描其内容。
- **超大文件**：相对 HEAD 有变化、且超过 `MAX_CHANGED_FILE_BYTES`（10 MiB）的文件让整次影子提交失败（`OversizedFileError`），既不丢弃也不免扫。用户的解法是加进 `.gitignore`。未变化的大文件已在历史里，不受影响。
- **sparse checkout**：直接拒绝。HEAD 的树读进新 index 时没有 skip-worktree 位，锥外文件会被记成删除。

## 5. 台账

一行一次迁移，`{"v":1,"at":<epoch ms>,"taskId":…,"state":…}` 加该状态的专有字段（`accepted` 带 `manifest`、`dispatched` 带 `node`、`done` 带 `result`、`failed` 带 `reason`）。

```
accepted ──▶ dispatched ──▶ running ──▶ done ──▶ returned
   │             │             │                    ▲
   └─────────────┴─────────────┴──▶ failed ─────────┘
```

- 计划 §1 只画了主链；`accepted → failed`、`dispatched → failed` 两条失败边是本包加的，否则派发阶段失败的任务会永远占着节点。
- **互斥**：任务处于 `dispatched` / `running` 时占用其节点；同节点再派发抛 `node_busy`。重放时同样判定，重启后互斥仍在。
- **末行写了一半**（没有换行收尾）：报在 `tornTail`，不生效；读取不改文件，下一次追加前截掉。最后一个换行之前的任何问题都以 `corrupt` 报行号并拒绝打开。
- **单写者**：一份台账只由一个进程（中枢）写。本包不加跨进程锁。

## 6. 已知限制

- 影子提交在 `git add` 阶段已把 blob 写进用户仓库的对象库，秘密命中时这些对象仍留在本地（不可达，随 `git gc` 回收），不会被推送。
- 影子提交与会话提交在本地都不被任何 ref 引用；`git gc` 的 prune 过期后可能被回收。下一次会话提交若引用了已被回收的父提交，`commit-tree` 会报错。
- 会话文件原样提交，**不做秘密扫描**。会话记录里可能有模型读到过的密钥；要不要扫、命中后拒推还是脱敏，尚待裁定。
- 台账没有压缩，任务只增不减；M1 单用户的量级下不是问题。
