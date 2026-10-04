// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hand-written material for the hardened corpus (`hardened.ts`,
 * `docs/dev/memory-m1.md` §2.4). Data only; the assembly rules live next door.
 *
 * WHY SIBLINGS
 *
 * In the v0.1 corpus the only hand-written, decision-shaped entries in scope
 * were the 21 gold ones; everything else came out of one template. The
 * reviewer's query-independent "outlier" ranker used exactly that split to
 * carry 17 of 20 zero-overlap gold entries into the block at 2000 entries,
 * without reading a question. Each gold decision therefore gets six siblings:
 * same topic, same register, same tag, same length profile, a different
 * object. "Same register" is measured, not assumed: gold bodies are short
 * statements (two of 21 start with 「理由：」, the filler template's opening)
 * and most gold entries name a tool or an identifier, so the siblings do the
 * same — a first draft that gave every sibling a 「理由：」 body still let the
 * outlier ranker pick gold out of the 141. A signal that separates "hand-written" from "generated" now lands
 * on 141 candidates of which 21 are gold, which is far more than the 25 free
 * slots of the §5.1 fusion can hold.
 *
 * WHAT A SIBLING MUST NOT DO
 *
 * It must not answer any question of the corpus — not its own family's, and
 * not a negative one (no front-end framework, no log backend, no CI
 * concurrency limit, no measured wake latency, no backup retention, no test
 * runner, no package manager). If it did, the gold label of that question
 * would be wrong. Siblings also avoid restating a neighbouring gold decision
 * (a sandbox sibling that said "credentials come from the environment" would
 * answer the secrets questions). The test suite checks the mechanical half of
 * this (forbidden words); the semantic half is this comment and review.
 */

/** Six siblings per gold decision, keyed by the gold's `key`. */
export const SIBLINGS: Readonly<
  Record<
    string,
    readonly (readonly [title: string, summary: string, body: string])[]
  >
> = {
  runtime: [
    [
      '统一用 TypeScript 5 的 strict 配置',
      '所有包继承同一份 tsconfig，不单独放宽 noImplicitAny',
      '理由：类型错误在 CI 之前暴露。',
    ],
    [
      '类型检查只跑 tsc --noEmit',
      '产物由 Vite 打包，tsc 不输出任何 JS 文件',
      '两步职责分开。',
    ],
    [
      '构建产物统一落到 dist 目录',
      '各入口共用一个 outDir，不散落到 packages 里',
      '清理与部署只认一个路径。',
    ],
    [
      '脚本入口统一写进 package.json 的 scripts',
      '不另建 Makefile 或 justfile',
      '命令只有一处可查。',
    ],
    [
      '模块格式统一用 ESM',
      '新代码不再写 require，旧代码随改随迁到 import',
      '与打包器的 tree-shaking 一致。',
    ],
    [
      '路径别名只保留 src/* 一个',
      '包之间走 workspace 名，不写深层相对路径',
      '重构时少改引用。',
    ],
  ],
  vector: [
    [
      '记忆条目写入后不可原地修改',
      'M0 的更正方式是 revoke 旧条目再写新条目',
      '原地修改会丢掉审计轨迹，M1 也不开放。',
    ],
    [
      '记忆按 working、project、baseline 三层分目录',
      '每层一个目录，跨层不共享文件',
      '分区本身就是权限边界。',
    ],
    [
      '注入块超过 50 条时按排序截断',
      '块头写明 mode 与 omitted 条数',
      '让模型分清没有和没放进来。',
    ],
    [
      '被 revoke 的条目下一轮起不再注入',
      '撤销只改 frontmatter，文件保留备查',
      '废止后必须重投，靠每轮重读磁盘保证。',
    ],
    [
      '记忆条目必须带来源 ID 与写入时间',
      'citation 行由 formatCitation 统一生成',
      '回答里的来源与盘上记录不会漂移。',
    ],
    [
      '工作层记忆在任务结束时归档',
      '值得保留的经 archiveWorkingMemory 沉淀到项目层',
      '避免工作层无限增长。',
    ],
  ],
  protocol: [
    [
      '信封体积上限以 LIMITS 为唯一出处',
      '各包不另写数值，文档只放指针',
      '数值只有一个家。',
    ],
    [
      '信封字段一律用 camelCase 命名',
      '新字段只能追加，不得改名或删除',
      '老节点读新信封不报错。',
    ],
    [
      '节点地址统一写成 qianmo URI',
      'host:port 旧写法只在迁移期兼容',
      '寻址与部署解耦。',
    ],
    [
      '任务默认 TTL 定为 5 分钟',
      '超时后发起方收到 expired 回执',
      '避免悬挂任务。',
    ],
    [
      '回执帧与消息帧分开编号',
      'ReceiptFrame 只确认序号，不带正文',
      '重投只针对未确认的尾部。',
    ],
    [
      '版本协商放在握手的第一帧',
      '不兼容时直接拒绝，不做静默降级',
      '理由：错配比失败更难排查。',
    ],
  ],
  sandbox: [
    [
      '沙箱基础镜像按月重建',
      '基础层 apt 版本写进构建记录，镜像标签带日期',
      '安全补丁不积压。',
    ],
    [
      '沙箱内默认不挂载宿主 HOME',
      '只挂入当前任务的 workspace 卷',
      '最小暴露。',
    ],
    [
      '冻结态沙箱保留进程与监听端口',
      'unpause 后直接恢复，不重新拉起',
      '状态字节级完好，PID 不变。',
    ],
    [
      '每个沙箱的 memory 上限按节点规格分档',
      '1.9 GB 的小机器取下档',
      '防止宿主被 OOM。',
    ],
    ['沙箱出网走 egress 白名单', '只放行模型网关与包仓库镜像', '限制外连面。'],
    ['沙箱崩溃后保留最后一次 snapshot', '排查结束再手动 prune', '便于取证。'],
  ],
  capability: [
    [
      '节点身份私钥文件权限固定为 0600',
      '所在目录为 0700，启动时校验 stat',
      '同机其他用户读不到。',
    ],
    [
      '审批签名与对话签名分用两把密钥',
      '--wake-sign 与 --chat-sign 各自轮换',
      '一把泄露不牵连另一把。',
    ],
    [
      '令牌有效期不超过 10 分钟',
      '过期后必须重新申请，不做静默续期',
      '缩短泄露窗口。',
    ],
    [
      'CRL 每小时拉取一次',
      '拉取失败时沿用上一份并告警',
      '可用性优先，但要留痕。',
    ],
    [
      '审计链记录只追加不删除',
      '每条带前一条的 SHA-256 摘要',
      '篡改可以被发现。',
    ],
    [
      '管理 token 只接受 Authorization 头',
      '不从 query string 读取',
      '避免进入访问日志。',
    ],
  ],
  backup: [
    [
      '快照上传前先做完整性校验',
      '校验值用 SHA-256，随快照一起存放',
      '坏包不进仓库。',
    ],
    [
      '备份窗口避开每日 CI 构建时段',
      '统一排在凌晨 3 点到 5 点',
      '减少资源争用。',
    ],
    [
      '快照文件名带节点名与单调序号',
      '序号不复用，格式为 node-seq.tar.zst',
      '跨节点可以排序。',
    ],
    [
      '备份任务失败只自动重试一次',
      '仍失败则告警，等人工处理',
      '避免反复占用带宽。',
    ],
    [
      '快照只收 workspace，不含 node_modules',
      '依赖目录在打包时排除',
      '体积缩小一个数量级。',
    ],
    [
      '快照上传走节点自己的出口',
      '不经中枢转发，中枢只存索引',
      '理由：中枢不承载数据面。',
    ],
  ],
  license: [
    [
      '新建自有文件必须带两行 SPDX 版权头',
      '头放在文件前 5 行之内',
      '来源层可以机检。',
    ],
    [
      '基座文件即使改造过也不加版权头',
      '头只标记来源层，不作归属判据',
      '避免误标。',
    ],
    [
      'SBOM 每次发版前重新生成',
      '清单只读 bun.lock，不猜测',
      '许可审查有据可查。',
    ],
    [
      '文档与图片的许可口径单独写进 NOTICE',
      '与代码许可分开表述',
      '非代码资产口径不同。',
    ],
    ['大赛 logo 不随仓库许可授出', '使用时另行取得授权', '属于第三方标识。'],
    ['贡献者提交即同意按仓库许可发布', '不另签 CLA', '理由：流程从简。'],
  ],
  shards: [
    [
      '每个分片输出一份 JUnit XML',
      '报告目录在每次运行前清空',
      '失败时能看到用例名与耗时。',
    ],
    ['合并请求必须等全部 check 通过', '管理员也不能跳过', '主干始终可以发布。'],
    [
      '覆盖率 lcov 按分片拼接后上传',
      '不设覆盖率门槛，只看趋势',
      'Codecov 只做展示。',
    ],
    [
      'CI 缓存以 bun.lock 摘要为键',
      'lockfile 一变缓存即失效',
      '避免陈旧依赖。',
    ],
    ['夜间任务额外跑一次完整 build', '结果只通知维护者', '尽早发现打包问题。'],
    ['失败用例最多自动重跑一次', '两次都红才判失败', '区分 flaky 与真失败。'],
  ],
  utc: [
    [
      '日志级别默认取 info',
      '排查时临时调到 debug，结束后改回',
      '控制日志体积。',
    ],
    [
      '日志里不得出现 token 与密钥原文',
      '输出前按正则打码',
      '日志会被转发到别处。',
    ],
    ['每条日志带 traceparent', '跨节点可以串起同一次调用', '排查不靠猜。'],
    ['错误日志附带调用栈', 'warn 以下不带 stack', '降低噪音。'],
    [
      '审计记录与运行日志分开存放',
      '审计记录不参与 logrotate',
      '保留期限不同。',
    ],
    ['日志字段名统一用 snake_case', '新增字段先登记再使用', '便于检索。'],
  ],
  copy: [
    [
      '控制台配色沿用品牌橙 #D77757',
      '危险操作按钮统一用红色',
      '视觉语义一致。',
    ],
    ['表格默认按时间倒序', '可切换排序，但不记忆用户选择', '最新的最常看。'],
    ['页面轮询间隔默认 10 秒', '后台标签页暂停轮询', '减轻中枢压力。'],
    ['危险操作需要二次确认', '确认框写明影响的节点数', '防止误操作。'],
    ['空状态页给出下一步操作', '除插画外不放其他装饰', '减少困惑。'],
    [
      '数字统一用千分位分隔',
      '时间显示为相对时间，hover 看绝对时间',
      '便于扫读。',
    ],
  ],
  wake: [
    ['首字节延迟按 P50 报告', '不单独报最好成绩', '避免挑数。'],
    [
      '压测固定在同一台 4 vCPU 机器上跑',
      '每次记录机器规格与内核版本',
      '结果可以比较。',
    ],
    ['冷启动与热启动分开统计', '两者不合并平均', '成因不同，混算会掩盖问题。'],
    [
      '性能回归只在独立 job 里测',
      '不进合并门禁，N ≥ 5 取中位数',
      '抖动会造成误报。',
    ],
    [
      '常驻进程空载 RSS 目标定为 300 MB 以内',
      '超出时先查缓存',
      '小机器也要能跑。',
    ],
    ['队列排空时间纳入值守指标', '每周汇总一次 P90', '发现积压趋势。'],
  ],
  hops: [
    [
      '转发时保留原始发起方地址',
      'origin 字段中间节点不得改写',
      '回执能送回源头。',
    ],
    ['广播消息体积不超过普通消息的一半', '超出时改为 pull 模式', '控制带宽。'],
    [
      '消息优先级只分 normal 与 urgent 两档',
      'urgent 不参与批量合并',
      '规则简单。',
    ],
    [
      '离线节点的消息在中枢信箱最多保留 24 小时',
      '过期后通知发送方',
      '避免无限堆积。',
    ],
    ['路由表在每次注册变更后整体重建', '不做增量 patch', '实现简单不易错。'],
    [
      '节点名只允许小写字母、数字与连字符',
      '长度不超过 32',
      '理由：可以直接用作目录名。',
    ],
  ],
  upstream: [
    [
      '改基座核心文件必须写明原因',
      '能走 ACP、MCP、hooks 扩展点的不改核心',
      '减少将来的冲突面。',
    ],
    [
      '基座改造点集中登记在 base-modifications.md',
      '新增改造点先登记再动手',
      '改动面可以盘点。',
    ],
    [
      '基座里已删除的子系统不再恢复',
      'Remote Control 等需求一律自研',
      '不背负无人维护的代码。',
    ],
    [
      '导入提交 3380c88 之前的历史不改写',
      '禁止跨越导入点 squash',
      '成果边界可以举证。',
    ],
    [
      '基座自带的遥测默认关闭',
      '需要时由运维显式打开 OTel 导出',
      '不向外部发送使用数据。',
    ],
    [
      '基座的配置文件名保持原样',
      '阡陌自有配置另起 qianmo 子目录',
      '兼容官方状态。',
    ],
  ],
  notify: [
    [
      '值守任务定义由中枢统一保存',
      '节点只执行，不持久化任务定义',
      '换节点不丢任务。',
    ],
    ['急停用 ESTOP 文件标记', '节点每轮开始前检查', '不依赖网络也能停。'],
    ['重启过于频繁时自动熔断', '熔断后需要人工 reset', '防止重启风暴。'],
    ['节点心跳间隔定为 30 秒', '连续 3 次缺失判为离线', '兼顾及时与噪音。'],
    ['运维操作一律留痕', '记录操作人、时间与 requestId', '事后可以追责。'],
    ['配额统计按自然日重置', '每天零点切日，不结转', '口径简单。'],
  ],
  secrets: [
    [
      '依赖升级前先看 GitHub 安全公告',
      '高危 advisory 当天处理',
      '缩短暴露窗口。',
    ],
    [
      '外部依赖只从官方 registry 安装',
      '不使用镜像站的非官方包',
      '降低投毒风险。',
    ],
    ['生产环境的 debug 接口默认关闭', '需要时限时开启', '减少攻击面。'],
    ['管理页面只允许内网访问', '外网入口一律经反向代理鉴权', '边界清晰。'],
    [
      '安全问题通过 SECURITY.md 的私密渠道报告',
      '修复发布前不公开细节',
      '负责任披露。',
    ],
    [
      '失败的登录尝试按来源 IP 限速',
      '连续 5 次失败锁定 15 分钟',
      '抵御暴力破解。',
    ],
  ],
  compact: [
    ['常驻会话按 agent 与 contextId 分区', '不同上下文互不可见', '避免串话。'],
    ['每轮开始时冻结记忆快照', '本轮内的新写入下一轮才生效', '结果可以复现。'],
    ['入站消息先落 ledger 再处理', '崩溃后按 ledger 重放', '不丢消息。'],
    [
      '同一会话同时只允许一轮在跑',
      '后到的消息合并进下一轮 batch',
      '避免交错写入。',
    ],
    [
      '常驻工具面只保留必需的工具',
      'Cron 类工具不开放',
      '收窄无人值守时的能力。',
    ],
    ['对端消息拼进 prompt 前先中和', '尖括号转成实体', '防止结构注入。'],
  ],
  'docs-lang': [
    ['同一事实只写在一处', '其他地方只放指向它的链接', '避免多处漂移。'],
    [
      '设计件定稿后只追加变更记录',
      '正文改动随版本号一起升，如 v1.0 到 v1.1',
      '改动可以追溯。',
    ],
    [
      '文档数字必须标明是测量值还是估算',
      '未验证的写明未验证',
      '避免把推断当事实。',
    ],
    ['对外材料由负责人确认后发出', '内部草稿不外传', '口径统一。'],
    ['文档站页面按模块分目录', '每个目录一个 index 页', '链接稳定。'],
    ['评审意见写进 review 报告', '原文由作者自己修改', '分清责任。'],
  ],
  paths: [
    [
      '节点身份名只在 identity.ts 里拼写一次',
      '其他地方引用 NODE_IDENTITY_MODE',
      '改名不会漏。',
    ],
    [
      '凭据迁移必须由用户显式选择',
      '不自动搬运官方客户端的凭据',
      '尊重用户选择。',
    ],
    ['子进程继承的环境变量先过白名单', '身份相关变量不外泄', '隔离不被击穿。'],
    [
      '进程名与 socket 前缀用阡陌自己的名字',
      '不沿用官方客户端的名字',
      '避免冲突。',
    ],
    [
      '协议兼容字符串保持原样',
      '改名只改展示层，User-Agent 不动',
      '改了会以难以诊断的方式坏掉。',
    ],
    [
      '缓存命名空间与身份同源',
      'CACHE_NAMESPACE 随身份一起切换',
      '不串用缓存。',
    ],
  ],
  provision: [
    ['装机凭据以信封加密落盘', 'KEK 不与密文同机存放', '降低单点泄露影响。'],
    ['装机脚本执行前先 dry-run', 'dry-run 输出需人工确认', '防止误操作。'],
    ['新节点上线前先跑一次 smoke', '不通过不进 peers.conf', '坏节点不接流量。'],
    ['装机日志保留在控制台所在机器', '不回传到节点', '集中审计。'],
    ['退役节点先吊销证书再删 VM', '顺序不可颠倒', '防止残留身份被冒用。'],
    ['每台机器只装一个常驻节点', '不在一台 VPS 上混跑多个', '故障域清晰。'],
  ],
  release: [
    ['发行说明按版本单独成文', '每篇写明修复与已知问题', '便于回溯。'],
    ['版本号采用 SemVer', '破坏性改动升主版本', '兼容性可预期。'],
    ['节点构建产物只在构建机上生成', '本地构建不用于部署', '环境一致。'],
    ['部署前先停旧进程再换 dist', '换完做一次健康检查', '避免半新半旧。'],
    ['发行前在干净 clone 上跑完整门禁', '不以工作区结果为准', '排除本地残留。'],
    [
      '内测版本先部署到一台节点观察一天',
      '无异常再推到其余节点',
      '理由：控制影响面。',
    ],
  ],
}

/**
 * The answer-layer `mustMention` of each gold decision, with synonyms.
 * Each inner list is one requirement satisfied by any of its spellings;
 * matching is done after NFKC, lower-casing and whitespace removal.
 */
export const MUST_MENTION_ANY: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  runtime: [['bun']],
  vector: [['向量']],
  protocol: [['自研', '自行研发', '自己研发']],
  sandbox: [['dormice']],
  capability: [['ed25519']],
  backup: [['自研', '自行研发', '自己研发']],
  license: [['agpl']],
  shards: [['分片']],
  utc: [['utc', '协调世界时']],
  copy: [['冷静']],
  wake: [['60', '六十']],
  hops: [['maxhops']],
  upstream: [['三方']],
  notify: [['静默']],
  secrets: [['环境变量']],
  compact: [['压缩']],
  'docs-lang': [['中文']],
  paths: [['paths.ts']],
  provision: [['控制面']],
  release: [['不发布']],
  ndjson: [['ndjson']],
}

/**
 * Twenty-two more decisions that were never written, on top of v0.1's eight
 * (30 per tier, the E2 sample-size floor of §2.4 item 6). The first sixteen
 * name technology the corpus never mentions; the last six are lexical lures
 * built on filler subjects and settings with a value the filler lists do not
 * contain, the same construction as v0.1's `shard-90s` and `backup-90d`.
 */
export const MORE_FABRICATED: readonly {
  readonly key: string
  readonly question: string
}[] = [
  { key: 'redis', question: '缓存层是不是定了用 Redis？' },
  { key: 'graphql', question: '接口是不是统一改成 GraphQL 了？' },
  { key: 'oauth', question: '登录是不是接了 OAuth 单点登录？给出来源 ID。' },
  { key: 'grafana', question: '监控面板定的是 Grafana 吗？' },
  { key: 'sentry', question: '错误上报是不是接入了 Sentry？' },
  { key: 'terraform', question: '基础设施是不是用 Terraform 管理？' },
  { key: 'compose', question: '本地开发环境是不是统一用 Docker Compose 起？' },
  { key: 'ios', question: '移动端是不是先做 iOS 版？' },
  { key: 'clickhouse', question: '数据仓库选的是 ClickHouse 吗？' },
  { key: 'minio', question: '对象存储是不是定了用 MinIO？' },
  { key: 'wecom', question: '消息推送是不是接入了企业微信？' },
  { key: 'billing', question: '计费是不是按调用次数向用户收费？' },
  { key: 'i18n-ja', question: '国际化是不是先支持日语界面？' },
  { key: 'pool-200', question: '数据库连接池上限定为 200 了吗？' },
  { key: 'webpack', question: '前端打包是不是换成 Webpack 了？' },
  { key: 'editorconfig', question: '编辑器配置是不是统一用 EditorConfig？' },
  { key: 'registry-75s', question: '注册中心的超时阈值调整为 75 秒了吗？' },
  { key: 'scheduler-24', question: '调度器的并发数上限改成 24 了吗？' },
  { key: 'audit-90d', question: '审计日志的保留周期定为 90 天是哪条？' },
  { key: 'console-verbose', question: '控制台的日志级别定为 verbose 了吗？' },
  { key: 'snapshot-20m', question: '快照清理的采样间隔是不是定为 20 分钟？' },
  { key: 'deploy-7', question: '部署脚本的重试次数上限改成七次了吗？' },
]

/**
 * 「相关但不支持」 lures (§2.4 item 6): one per gold family, asserting a claim
 * the corpus does not record about a topic it does record. `G = ∅`; the
 * family's gold is the one acceptable citation (`S = {gold}`), because "not
 * recorded — what is recorded is X [X]" is a correct answer, not a
 * misattribution.
 */
export const UNSUPPORTED: Readonly<Record<string, string>> = {
  runtime: '运行时是不是已经换成 Deno 了？',
  vector: '记忆召回是不是已经改用全文搜索引擎了？',
  protocol: '跨节点消息是不是已经整体切到 gRPC 了？',
  sandbox: '沙箱是不是改成 Kata Containers 了？',
  capability: 'capability 是不是改用 RSA 签发了？',
  backup: '备份是不是交给云厂商的托管服务了？',
  license: '自有代码是不是改用 GPL-2.0 了？',
  shards: '单测是不是改成按文件随机分组跑了？',
  utc: '日志时间是不是统一改成北京时间了？',
  copy: '控制台文案是不是要求改成口语化了？',
  wake: '唤醒预算是不是已经放宽到 120 秒了？',
  hops: '跳数上限是不是取消了，改成完全靠超时？',
  upstream: '上游同步是不是改成直接 rebase 了？',
  notify: '值守产出是不是改成每轮都推送了？',
  secrets: '凭据是不是改成放进配置文件里读取了？',
  compact: '值守轮次是不是允许自动压缩了，只要先存档？',
  'docs-lang': '设计文档是不是要求中英双语各写一份？',
  paths: '运行时路径是不是改成读取环境变量里的绝对路径了？',
  provision: 'SSH 装机是不是也负责转发业务数据了？',
  release: '本仓库是不是开始往 npm 发预览版了？',
}

/**
 * Words no sibling or filler may contain: each would make a negative
 * question answerable or a positive one ambiguous. Checked by the test suite.
 */
export const FORBIDDEN_IN_DISTRACTORS: readonly string[] = [
  'react',
  'vue',
  'jest',
  'npm',
  'pnpm',
  'elasticsearch',
  'kafka',
  'kubernetes',
  'flyway',
  'prettier',
  '短信',
  '并发上限',
  '90 秒',
  '90 天',
  'postgresql',
  'deno',
  'grpc',
  'kata',
  'rsa',
  'gpl-2',
  'rebase',
  'redis',
  'graphql',
  'oauth',
  'grafana',
  'sentry',
  'terraform',
  'docker compose',
  'ios',
  'clickhouse',
  'minio',
  '企业微信',
  '收费',
  '日语',
  '连接池',
  'webpack',
  'editorconfig',
  '75 秒',
  'verbose',
  '20 分钟',
  '七次',
  '北京时间',
]

/**
 * Neutral chatter for the batch-shaped variants (§2.4 item 3). A resident's
 * ranking question is the whole rendered batch, so other messages of the
 * batch are part of what the ranker and an embedding see.
 */
export const BATCH_CHATTER: readonly string[] = [
  '收到，我先看一下。',
  '上午那个会改到下午四点了。',
  '上一轮的结果已经贴出来了。',
  '这个不急，明天回复也行。',
  '麻烦顺便确认一下。',
  '我这边刚开完会。',
]

/** How a batch variant's messages are laid out around the question. */
export const BATCH_LAYOUTS: readonly (readonly ('q' | number)[])[] = [
  ['q'],
  [0, 'q'],
  ['q', 1, 2],
  [3, 'q'],
  [4, 'q', 5],
]

/** Title phrasings for the de-templated filler (`S` subject, `K` setting, `V` value). */
export const FILLER_TITLE_FORMS: readonly ((
  s: string,
  k: string,
  v: string,
) => string)[] = [
  (s, k, v) => `${s}的${k}定为 ${v}`,
  (s, k, v) => `${s}${k}改为 ${v}`,
  (s, k, v) => `${k}（${s}）固定为 ${v}`,
  (s, k, v) => `${s}：${k}暂定 ${v}`,
  (s, k, v) => `把${s}的${k}设为 ${v}`,
  (s, k, v) => `${s}的${k}沿用 ${v}`,
  (s, k, v) => `${s}${k}调整到 ${v}`,
  (s, k, v) => `决定${s}${k}取 ${v}`,
]

export const FILLER_SUMMARY_FORMS: readonly ((
  s: string,
  k: string,
  v: string,
) => string)[] = [
  (s, k, v) => `${s}：${k}调整为 ${v}`,
  (s, k, v) => `${k}由默认值改为 ${v}，只影响${s}`,
  (s, k, v) => `适用于${s}，${k}取 ${v}`,
  (s, k, v) => `${s}按 ${v} 执行，不再沿用旧的${k}`,
  (s, k, v) => `${s}这一侧的${k}统一为 ${v}`,
  (s, k, v) => `${v} 作为${s}的${k}，其余组件不变`,
  (s, k, v) => `只改${s}的${k}，新值 ${v}`,
  (s, k, v) => `${s}的${k}在各节点上一致取 ${v}`,
]

/** v0.1's twelve reasons plus twenty-four more. */
export const MORE_FILLER_REASONS: readonly string[] = [
  '理由：上一版配置在高峰期不够用。',
  '理由：与相邻组件的设置对齐。',
  '理由：减少人工介入。',
  '理由：旧值是早期随手定的。',
  '理由：让告警更早出现。',
  '理由：节省带宽。',
  '理由：排障时信息更全。',
  '理由：避免与定时任务撞车。',
  '理由：迁移期间保持保守。',
  '理由：压测结果支持这个值。',
  '理由：降低误判。',
  '理由：与文档描述保持一致。',
  '理由：新机器规格更高。',
  '理由：旧机器规格偏低。',
  '理由：兼顾速度与稳定。',
  '理由：减少重复工作。',
  '理由：便于横向比较。',
  '理由：运维反馈原值太敏感。',
  '理由：原值导致积压。',
  '理由：统一口径。',
  '理由：先保守，观察后再放开。',
  '理由：与上游默认值保持距离。',
  '理由：审计时更好解释。',
  '理由：用户侧感知更平滑。',
]

/** Optional second body sentence for the de-templated filler. */
export const FILLER_FOLLOW_UPS: readonly string[] = [
  '下次评审时复核。',
  '若出现告警再调整。',
  '已同步到运维手册。',
  '变更前后各跑一轮冒烟。',
  '先在一台节点上观察一天。',
  '回滚只需改回旧值。',
  '不影响已有数据。',
  '需要重启相关进程。',
  '由值班人执行。',
  '配置写在节点自己的文件里。',
  '与上游默认值不同。',
  '变更记录见发行说明。',
]

/**
 * Filler tags drawn from the gold families' own tag vocabulary. In v0.1 the
 * filler tags (`registry`, `transport`, …) and the decision tags barely
 * overlapped, so the `tags:` line alone separated the two populations.
 */
export const FILLER_TAG_BY_SUBJECT: Readonly<Record<string, string>> = {
  注册中心: 'protocol',
  传输层: 'protocol',
  控制台: 'ui',
  调度器: 'ops',
  备份任务: 'backup',
  审计日志: 'security',
  构建脚本: 'toolchain',
  测试分片: 'ci',
  沙箱镜像: 'sandbox',
  证书轮换: 'security',
  消息信箱: 'protocol',
  唤醒器: 'perf',
  配额统计: 'ops',
  文档站: 'docs',
  流水线: 'ci',
  节点探针: 'ops',
  会话存储: 'resident',
  权限审批: 'security',
  升级脚本: 'upstream',
  告警通知: 'ops',
  索引服务: 'memory',
  指标采集: 'perf',
  快照清理: 'backup',
  部署脚本: 'provisioning',
}

/**
 * The working-layer partition case (§2.4 item 4). The resident recalls from
 * `working/<agent segment>/<context segment>` (`residentRecallScope` in
 * `packages/resident/src/memory-sidecar.ts`), and none of v0.1's three
 * cross-scope negatives exercised that partition. Segments are spelled the
 * way that function spells a plain value: a `v-` prefix and the value.
 */
export const RESIDENT_AGENT_SEGMENT = 'v-eval-agent'
export const CONTEXT_A_SEGMENT = 'v-ctx-alpha'
export const CONTEXT_B_SEGMENT = 'v-ctx-beta'

export const CONTEXT_ENTRIES: readonly {
  readonly key: string
  readonly context: 'a' | 'b'
  readonly title: string
  readonly summary: string
  readonly body: string
}[] = [
  {
    key: 'ctx-a-triage',
    context: 'a',
    title: '本轮排查先看网关超时',
    summary: '用户要求先排除网关超时，再看节点日志',
    body: '这位用户说过两次。',
  },
  {
    key: 'ctx-b-triage',
    context: 'b',
    title: '本轮排查先看磁盘占用',
    summary: '用户要求先排除磁盘占用，再看节点日志',
    body: '这位用户说过两次。',
  },
  {
    key: 'ctx-a-report',
    context: 'a',
    title: '周报用表格列出异常',
    summary: '这位用户要求值守周报用表格逐条列出异常',
    body: '不要写成段落。',
  },
  {
    key: 'ctx-b-report',
    context: 'b',
    title: '周报用段落叙述异常',
    summary: '这位用户要求值守周报用段落叙述异常',
    body: '不要写成表格。',
  },
  {
    key: 'ctx-a-lang',
    context: 'a',
    title: '回复一律用中文',
    summary: '这位用户不看英文回复',
    body: '术语可以保留英文原词。',
  },
  {
    key: 'ctx-a-hours',
    context: 'a',
    title: '只在工作日处理告警',
    summary: '周末的告警留到周一统一处理',
    body: '紧急情况除外。',
  },
  {
    key: 'ctx-b-disk',
    context: 'b',
    title: '磁盘告警阈值临时放宽',
    summary: '这位用户要求磁盘告警阈值临时调到百分之九十五',
    body: '迁移结束后改回。',
  },
  {
    key: 'ctx-b-maint',
    context: 'b',
    title: '节点下周二停机维护',
    summary: '这位用户的节点下周二凌晨停机维护',
    body: '维护期间不派发任务。',
  },
]

export const CONTEXT_QUERIES: readonly {
  readonly id: string
  readonly question: string
  readonly gold: readonly string[]
  readonly forbidden: readonly string[]
  readonly mustMentionAny: readonly (readonly string[])[]
}[] = [
  {
    id: 'xctx-triage',
    question: '这次排查先看什么？',
    gold: ['ctx-a-triage'],
    forbidden: ['ctx-b-triage'],
    mustMentionAny: [['网关']],
  },
  {
    id: 'xctx-report',
    question: '周报用什么形式写？',
    gold: ['ctx-a-report'],
    forbidden: ['ctx-b-report'],
    mustMentionAny: [['表格']],
  },
  {
    id: 'xctx-disk',
    question: '磁盘告警阈值现在是多少？',
    gold: [],
    forbidden: ['ctx-b-disk'],
    mustMentionAny: [],
  },
  {
    id: 'xctx-maint',
    question: '节点什么时候停机维护？',
    gold: [],
    forbidden: ['ctx-b-maint'],
    mustMentionAny: [],
  },
]
