<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# scripts/ops —— 宿主侧安全面加固（阡陌 S0 P0.7）

实验/演示服务器的**部署面**运维产物。这里的东西不参与构建、不进产物包，只在宿主上执行。

任务包背景、验收判据（DoD）与实测记录都在 `docs/dev/`（roadmap 的 P0.7、selection-m0 的 D-5），本文只讲这三个文件本身怎么用——**不在这里复述那边的事实**。

## 为什么需要这些脚本

AC-6(c)（智能体逃不出沙箱边界、删不掉自己的备份）此前**只靠一件事**成立：Dormice daemon 绑在回环地址。daemon 的凭据没有权限分级——销毁沙箱与执行命令是同一把。绑定地址一旦被改坏，沙箱里的智能体立刻拿到销毁自己宿主的能力，且不会有任何报错。

单点依赖不是「已经安全」，是「还没出事」。这里做的是把它变成两层：网络层挡住（`harden-dormice-host.sh`），绑定层持续自检（`check-daemon-bind.sh`），docker 生命周期上自动重加（`dormice-harden.service`）。

## 一条反直觉的结论（真机实测得出，不要凭直觉改回去）

**容器访问宿主本机端口的流量走 `INPUT` 链，不走 `FORWARD`，因此也不走 `DOCKER-USER`。** 只往 `DOCKER-USER` 加规则对这个威胁**完全无效**。

证据链是从沙箱容器探测宿主 daemon 端口，用连接三态区分「端口无监听、内核回 RST」与「被 DROP 静默丢弃」得到的：

| 阶段 | 从沙箱探测 daemon 端口 | 结论 |
| --- | --- | --- |
| 加固前 | `ECONNREFUSED` | daemon 绑回环，容器够不到（但这是唯一依靠） |
| 仅加 `DOCKER-USER` 规则 | `ECONNREFUSED`（不变） | 该链对此威胁无效 |
| 再加 `INPUT` 规则 | `TIMEOUT` | `INPUT` 上那条才是生效项 |

全程宿主的 80 端口保持可达，说明加固精准、无误伤。

所以 `harden-dormice-host.sh` **两条链都加**：`INPUT` 是生效的那条，`DOCKER-USER` 是纵深冗余（它挡的是另一类路径：经 `FORWARD` 转发的容器流量），不是可省略的装饰。删掉任何一条，`__tests__/daemon-bind-invariant.test.ts` 会变红。

## 三个文件

| 文件 | 干什么 | 在哪跑 |
| --- | --- | --- |
| `harden-dormice-host.sh` | 幂等地往 `INPUT` 与 `DOCKER-USER` 链首各插一条 DROP 规则，禁止沙箱网桥上的流量到达 daemon 端口 | 宿主，root |
| `check-daemon-bind.sh` | 断言 daemon 只监听回环。0 = 成立，1 = 被破坏，2 = 无法判定 | 宿主（或用快照离线判定 / CI） |
| `dormice-harden.service` | 把加固脚本绑在 `docker.service` 的生命周期上 —— docker 重启会 flush 并重建 `DOCKER-USER` 链，不绑就会被悄悄抹掉 | 宿主，systemd |

三个文件都**不含任何主机名、IP 地址、用户名或凭据**：端口与网卡名走环境变量并带默认值，网段一律用**网卡名**（`-i`）匹配而不写网段字面量，所以脚本里连一个 RFC1918 地址都不需要出现。这一条本身也是被断言的（见下）。

## 用法

```bash
# 预览将要执行的 iptables 命令（不需 root，不改任何规则）
./harden-dormice-host.sh --dry-run

# 应用加固（幂等，重复执行不累积规则）
sudo ./harden-dormice-host.sh

# 自检绑定不变式；退出码就是结论
./check-daemon-bind.sh; echo "exit=$?"

# 换端口/网卡：一律走环境变量，不改脚本
DORMICE_DAEMON_PORT=<port> DORMICE_DOCKER_IF=<bridge> sudo ./harden-dormice-host.sh
```

安装成开机自起（跟随 docker）：

```bash
sudo install -m 0755 harden-dormice-host.sh /usr/local/sbin/harden-dormice-host.sh
sudo install -m 0644 dormice-harden.service /etc/systemd/system/dormice-harden.service
sudo systemctl daemon-reload
sudo systemctl enable --now dormice-harden.service

# 验证生命周期绑定：删掉规则或重启 docker 之后，规则应自动回到链首
sudo systemctl restart docker
sudo iptables -S INPUT | head -3
```

环境变量清单见各脚本头部注释与 `--help`。

## 加固效果怎么验

从沙箱容器里探测宿主的 daemon 端口，看是 `TIMEOUT` 还是 `ECONNREFUSED`：

- `TIMEOUT` = 被防火墙 DROP，加固生效；
- `ECONNREFUSED` = 包到达了内核、只是没有监听——**说明防火墙那层没挡住**，daemon 一旦开始监听就会被够到。

两者的区别是这套加固的全部意义所在，不要只看「连不上」就当作安全。

## CI 里断言了什么

`__tests__/daemon-bind-invariant.test.ts`（随 `bun test` / CI 的 `scripts` 分片跑）：

1. **`check-daemon-bind.sh` 的判定逻辑**——用固定的监听表快照（`DORMICE_LISTEN_SNAPSHOT`）喂给真正会上线的那个脚本，绿灯与红灯两个方向都断言：回环监听绿、通配与具体网卡地址红、未监听不判定、端口取自环境变量。CI runner 上没有 daemon 也够不到部署环境，**所以断言的是判定逻辑而不是探测结果**——探测式断言在 CI 上只能恒绿，等于没有断言。
2. **`harden-dormice-host.sh` 的加固计划**——`--dry-run` 的输出里必须同时有 `INPUT` 与 `DOCKER-USER`，且每条链都是「先删后插链首」。上面那条反直觉结论就是靠它防止被人「优化」掉。
3. **这四个文件不含主机名 / 地址 / 凭据**——DoD 的硬要求，配负向自测。
4. **前向守卫**：仓库里凡提到 Dormice 的代码/配置，端点不得指向非回环地址。**今天它扫到的文件数为零**（仓库尚无 Dormice 集成代码），所以这条本身恒绿；它的红灯方向由 fixture 负向自测保证，P1.3 接入 Dormice 后无需改动即自动生效。

没有 shellcheck 门禁，`bash -n` 由上述测试代跑。
