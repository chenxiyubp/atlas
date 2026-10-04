#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌舰队产物的 Linux 构建配方（可重跑）。
#
# 为什么必须 Linux：macOS 上 rolldown 会把 npm 的纯 JS ws 内联进 chunk，Bun 下每次
# WebSocket 握手都静默失败（30 s 超时）。Linux 构建保留裸 `import ... from "ws"`。
#
# 做法：本机 `git bundle` 取源（仓库只读，不 checkout、不改工作区）→ colima 里的
# ubuntu 容器 → 非 root 用户从 bundle 真 clone（带真 .git，天然没有 macOS 扩展属性）→
# 钉 .tool-versions 的 bun → bun install --frozen-lockfile → postinstall 两个 ripgrep
# 目标 → build:vite → check:bundle → 独立复核（SOURCE_COMMIT 恰一个且等于 HEAD、ws 外部化）
# → payload.tgz（dist + demo）。
#
# 用法：
#   linux-build.sh [--branch fix/m1-gap-closure] [--commit <40位sha，缺省=分支头>] [--platform linux/arm64]
#                  [--repo /Users/cornna/project/atlas] [--out <目录，缺省在 ~/.atlas-fleet-build/out/ 下>]
# 退出码：0 = 全部判据通过；非 0 = 第一个失败的判据（见 out/verdict.txt）。
#
# Linux 构建机（含 GitHub runner，见 .github/workflows/fleet-payload.yml）不用 colima：
# 设 DOCKER_CONTEXT_NAME=default，本机 docker 通就直接用。
set -euo pipefail

BRANCH=fix/m1-gap-closure
EXPECT=""
PLATFORM=linux/arm64
REPO=/Users/cornna/project/atlas
OUT=""
# 专用 colima profile：default profile 的 docker 数据盘已被别的项目占满（2026-09-26 实测 100%），
# 不去清别人的镜像。首次需要：colima start atlas-build --cpu 4 --memory 6 --disk 40 --vm-type vz --mount-type virtiofs
COLIMA_PROFILE="${COLIMA_PROFILE:-atlas-build}"
DOCKER_CONTEXT="${DOCKER_CONTEXT_NAME:-colima-$COLIMA_PROFILE}"
# node:20-slim（Debian bookworm）：自带 node 给 postinstall.cjs 用；apt 走 deb.debian.org。
# ubuntu 镜像的 ports.ubuntu.com 明文 http 在本机代理下回 400，别换回去。
IMAGE="${BUILD_IMAGE:-node:20-slim}"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2;;
    --expect|--commit) EXPECT="$2"; shift 2;;
    --platform) PLATFORM="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

BRANCH_HEAD="$(git -C "$REPO" rev-parse --verify "refs/heads/$BRANCH^{commit}")"
# 分支可能正被别的会话推进：构建钉在一个确定的提交上（缺省取此刻的分支头）
HEAD_SHA="${EXPECT:-$BRANCH_HEAD}"
HEAD_SHA="$(git -C "$REPO" rev-parse --verify "$HEAD_SHA^{commit}")"
git -C "$REPO" merge-base --is-ancestor "$HEAD_SHA" "$BRANCH_HEAD" \
  || { echo "$HEAD_SHA is not on $BRANCH (head $BRANCH_HEAD)" >&2; exit 3; }
# 缺省产出不放脚本旁边：脚本在仓库里，scripts/fleet/build/ 不在 .gitignore 里，
# 一个 12 MB 的 payload.tgz 会以未跟踪文件留在工作区。
[ -n "$OUT" ] || OUT="$HOME/.atlas-fleet-build/out/${HEAD_SHA:0:8}-${PLATFORM//\//-}"
# colima 只把 $HOME 共享进 VM：容器的输入/输出必须落在家目录下，结束后再拷到 OUT。
WORK="$HOME/.atlas-fleet-build/${HEAD_SHA:0:8}-${PLATFORM//\//-}"
FINAL_OUT="$OUT"
OUT="$WORK"
rm -rf "$OUT" "$FINAL_OUT"; mkdir -p "$OUT/in" "$FINAL_OUT"

# ── 0. 构建机在不在（colima start 会顺手把 docker 默认 context 切过去，要切回来）──────
# 判活用 docker info 而不是 `colima status`：后者会经 limactl shell 跑 docker ps，实测会卡住。
if ! docker --context "$DOCKER_CONTEXT" info >/dev/null 2>&1; then
  # 没装 colima 的机器（Linux 构建机）：context 不通就照实说，别报成「colima 起不来」
  command -v colima >/dev/null 2>&1 \
    || { echo "docker context $DOCKER_CONTEXT unreachable, and no colima here to start (Linux: DOCKER_CONTEXT_NAME=default)" >&2; exit 4; }
  PREV_CTX="$(docker context show 2>/dev/null || echo default)"
  colima start "$COLIMA_PROFILE" >/dev/null 2>&1 || { echo "colima profile $COLIMA_PROFILE failed to start" >&2; exit 4; }
  docker context use "$PREV_CTX" >/dev/null 2>&1 || true
fi

# ── 1. 取源：bundle 只读仓库对象，不动工作区与 HEAD ─────────────────────────
git -C "$REPO" bundle create "$OUT/in/atlas.bundle" "$BRANCH" 2> "$OUT/bundle.log"
git -C "$REPO" bundle verify "$OUT/in/atlas.bundle" >> "$OUT/bundle.log" 2>&1
echo "bundle=$(du -h "$OUT/in/atlas.bundle" | cut -f1) commit=$HEAD_SHA branch=$BRANCH branch_head=$BRANCH_HEAD platform=$PLATFORM" | tee "$OUT/source.txt"

# ── 2. 容器内脚本 ────────────────────────────────────────────────────────────
cat > "$OUT/in/stage1-root.sh" <<'EOS'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
# 本机出网经代理，偶发连不上：apt 带重试，整体再试三轮
apt_ok=0
for i in 1 2 3; do
  if apt-get -o Acquire::Retries=5 update -qq >> /out/apt.log 2>&1 && \
     apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends curl unzip git ca-certificates xz-utils time >> /out/apt.log 2>&1; then
    apt_ok=1; break
  fi
  sleep 5
done
[ "$apt_ok" = 1 ] || { echo "APT_RC=failed" >> /out/rc.txt; exit 10; }
id builder >/dev/null 2>&1 || useradd -m -u 1001 builder
mkdir -p /home/builder/.bun/install/cache /home/builder/out
chown -R builder:builder /home/builder
install -o builder -g builder -m 0644 /in/atlas.bundle /home/builder/atlas.bundle
# builder 只写自己的家目录；root 最后整体拷回 /out（绑定挂载的属主不归容器管）
su builder -c "BRANCH='${BRANCH}' COMMIT='${COMMIT}' bash /in/stage2-builder.sh"
echo "STAGE2_EXIT=$?" >> /home/builder/out/rc.txt
cp -a /home/builder/out/. /out/
EOS

cat > "$OUT/in/stage2-builder.sh" <<'EOS'
set -uo pipefail
OUT=$HOME/out; W=$HOME/atlas
rc() { echo "$1=$2" >> $OUT/rc.txt; }
rm -rf "$W"
git clone -q --branch "$BRANCH" "$HOME/atlas.bundle" "$W" || { rc CLONE_RC failed; exit 20; }
cd "$W"
git checkout -q --detach "$COMMIT" || { rc CHECKOUT_RC failed; exit 22; }
HEAD=$(git rev-parse HEAD)
PINNED=$(tr -d '\r' < .tool-versions | awk '/^bun /{print $2}')
curl -fsSL https://bun.sh/install | bash -s "bun-v$PINNED" > $OUT/bun-install.log 2>&1 || { rc BUN_INSTALL_RC failed; exit 21; }
export PATH=$HOME/.bun/bin:$PATH
{
  echo "head=$HEAD"
  echo "pinned_bun=$PINNED actual_bun=$(bun --version)"
  echo "node=$(node --version) arch=$(uname -m) uid=$(id -u) user=$(id -un)"
  echo "toplevel=$(git rev-parse --show-toplevel)"
  echo "appledouble_files=$(find . -name '._*' -not -path './.git/*' | wc -l)"
  echo "clean_before_install=$(git status --porcelain | wc -l)"
} > $OUT/env.txt
bun install --frozen-lockfile > $OUT/install.log 2>&1; rc INSTALL_RC $?
node scripts/postinstall.cjs --target x64-linux --target arm64-linux > $OUT/postinstall.log 2>&1; rc POSTINSTALL_RC $?
echo "porcelain_before_build=$(git status --porcelain | wc -l)" >> $OUT/env.txt
git status --porcelain > $OUT/porcelain-before-build.txt
/usr/bin/time -v bun run build:vite > $OUT/build-vite.log 2> $OUT/build-vite.time; rc BUILD_RC $?
bun run check:bundle > $OUT/check-bundle.log 2>&1; rc CHECK_BUNDLE_RC $?
# 运行期冒烟：check:bundle 不查「调用了却没定义」的标识符（2026-09-26 的 init_external
# 就这样全绿地漏过去了）。-p 路径会加载 main chunk；无凭据时应以登录/鉴权类错误收场，
# 而不是 ReferenceError。不给任何凭据，不出网也行。
mkdir -p /tmp/rt/c
( cd /tmp/rt && env -i PATH="$PATH" HOME=/tmp/rt OCC_CONFIG_DIR=/tmp/rt/c timeout 90 bun "$W/dist/cli-node.js" -p "ping" < /dev/null > $OUT/runtime-p.log 2>&1; echo "exit=$?" >> $OUT/runtime-p.log )
( cd /tmp/rt && env -i PATH="$PATH" HOME=/tmp/rt OCC_CONFIG_DIR=/tmp/rt/c timeout 30 bun "$W/dist/cli-node.js" --version > $OUT/runtime-version.log 2>&1; echo "exit=$?" >> $OUT/runtime-version.log )
# 独立复核（不只信 check:bundle）
grep -rhoE 'return`[0-9a-f]{40}(-dirty)?`' dist | sort | uniq -c > $OUT/source-commit.txt
grep -rlE '(from\s*|import\s*|require\(\s*)["'"'"']ws["'"'"']' dist | sort > $OUT/ws-bare-import-files.txt
grep -rlE 'Unexpected server response|WS_ERR_INVALID_OPCODE' dist | sort > $OUT/ws-inlined-marker-files.txt
ls -R dist/vendor/ripgrep > $OUT/ripgrep-vendor.txt 2>&1
ls dist/demo > $OUT/dist-demo.txt 2>&1
find dist -type f | wc -l > $OUT/dist-file-count.txt
tar -czf $OUT/payload.tgz dist demo; rc TAR_RC $?
( cd dist && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > $OUT/dist-sha256.txt
EOS

# ── 3. 跑容器 ─────────────────────────────────────────────────────────────────
: > "$OUT/rc.txt"
START=$(date +%s)
set +e
# colima 默认 DNS（192.168.5.1）在本机 mihomo TUN 下会间歇性解析失败；显式给公网解析器
# （实际仍被 TUN 的 fake-ip 接管，走代理出网）。
docker --context "$DOCKER_CONTEXT" run --rm --platform "$PLATFORM" --dns "${BUILD_DNS:-1.1.1.1}" -e BRANCH="$BRANCH" -e COMMIT="$HEAD_SHA" \
  -v "$OUT/in:/in:ro" -v "$OUT:/out" \
  -v "atlas-fleet-bun-cache-${PLATFORM//\//-}:/home/builder/.bun/install/cache" \
  "$IMAGE" bash /in/stage1-root.sh > "$OUT/docker.log" 2>&1
DOCKER_RC=$?
set -e
echo "DOCKER_RC=$DOCKER_RC" >> "$OUT/rc.txt"
echo "elapsed_s=$(( $(date +%s) - START ))" >> "$OUT/source.txt"

# ── 4. 判定（全部判据写进 verdict.txt）────────────────────────────────────────
V="$OUT/verdict.txt"; : > "$V"; FAIL=0
check() { if eval "$2"; then echo "PASS $1" >> "$V"; else echo "FAIL $1" >> "$V"; FAIL=1; fi; }
for k in DOCKER_RC INSTALL_RC POSTINSTALL_RC BUILD_RC CHECK_BUNDLE_RC TAR_RC; do
  check "$k=0" "grep -qx '$k=0' '$OUT/rc.txt'"
done
check "env: uid!=0" "grep -q 'uid=1001' '$OUT/env.txt'"
check "env: bun pinned" "awk -F'[ =]' '/pinned_bun/{exit !(\$2==\$4)}' '$OUT/env.txt'"
check "env: appledouble=0" "grep -qx 'appledouble_files=0' '$OUT/env.txt'"
check "source_commit: exactly one value" "[ \$(wc -l < '$OUT/source-commit.txt') -eq 1 ]"
check "source_commit == $HEAD_SHA (no -dirty)" "grep -q 'return\`$HEAD_SHA\`' '$OUT/source-commit.txt'"
check "ws: bare import present" "[ -s '$OUT/ws-bare-import-files.txt' ]"
check "ws: npm ws not inlined" "[ -f '$OUT/ws-inlined-marker-files.txt' ] && [ ! -s '$OUT/ws-inlined-marker-files.txt' ]"
check "ripgrep: x64-linux + arm64-linux in dist/vendor" "grep -q 'x64-linux' '$OUT/ripgrep-vendor.txt' && grep -q 'arm64-linux' '$OUT/ripgrep-vendor.txt'"
check "runtime: --version runs" "grep -q 'exit=0' '$OUT/runtime-version.log'"
check "runtime: -p path loads without ReferenceError/SyntaxError" "[ -f '$OUT/runtime-p.log' ] && ! grep -qE 'ReferenceError|SyntaxError|is not a function' '$OUT/runtime-p.log'"
if [ -f "$OUT/payload.tgz" ]; then
  echo "payload=$OUT/payload.tgz size=$(du -h "$OUT/payload.tgz" | cut -f1) sha256=$(shasum -a 256 "$OUT/payload.tgz" | cut -d' ' -f1)" >> "$V"
fi
# 结果搬回 OUT（bundle 不搬：它是源，按需重建）
find "$OUT" -maxdepth 1 -type f -exec cp -p {} "$FINAL_OUT/" \;
mkdir -p "$FINAL_OUT/in" && cp -p "$OUT/in/"*.sh "$FINAL_OUT/in/"
# `sed -i ''` 是 BSD 专用：GNU sed 会把 '' 当脚本、把替换式当文件名，set -e 下整个配方
# 在这里退出 2，判定输出与退出码都丢。带后缀的 -i.bak 两边同义。
sed -i.bak "s|$OUT|$FINAL_OUT|g" "$FINAL_OUT/verdict.txt" && rm -f "$FINAL_OUT/verdict.txt.bak"
cat "$FINAL_OUT/verdict.txt"
exit $FAIL
