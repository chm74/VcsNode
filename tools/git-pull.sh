#!/bin/bash
# 拉取 SceneAutomation 最新代码（E:\vcsNode\project）
#
# 背景：本机到 github.com 的直连被拦（DNS 解析到 20.205.243.166，TCP 443 不通），
# 本机 Clash 代理（127.0.0.1:7890）也不稳定。
# 实测 140.82.112.3 直连可用，因此用 git 的 http.curloptResolve 定向解析，
# 不改 hosts、不影响系统其他程序。
#
# 网络恢复后可以把 PIN 去掉，直接用 git pull。
#
# 注意：远端 main 被强推过（2026-10-25），history 已重写，
# 无法 --ff-only，因此这里用 fetch + reset --hard。
# 本地若有未提交改动，先确认再执行。

set -u
cd /e/vcsNode/project || exit 1

PIN="http.curloptResolve=github.com:443:140.82.112.3"
BRANCH=main
OLD=$(git rev-parse HEAD)

echo "--- fetching origin/$BRANCH ..."
git -c "$PIN" fetch --depth=1 origin "$BRANCH" || { echo "FETCH_FAILED"; exit 1; }

NEW=$(git rev-parse FETCH_HEAD)
echo "OLD=$OLD"
echo "NEW=$NEW"

if [ "$OLD" = "$NEW" ]; then
  echo "ALREADY_UP_TO_DATE"
  exit 0
fi

if ! git merge-base --is-ancestor "$OLD" "$NEW" 2>/dev/null; then
  echo "WARNING: 远端历史已重写，本地无法快进，将 reset --hard"
  git status --short
fi

git reset --hard "$NEW" || { echo "RESET_FAILED"; exit 1; }
git branch --set-upstream-to="origin/$BRANCH" "$BRANCH" >/dev/null 2>&1 || true

echo "=== head ==="
git log -1 --format='%h  %ad  %s' --date=format:'%Y-%m-%d %H:%M'
echo "=== changed files (summary) ==="
git diff --stat "$OLD" "$NEW" | tail -5
