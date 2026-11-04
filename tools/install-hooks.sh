#!/bin/sh
# 启用仓库内版本化的 git 钩子。本地与服务器各执行一次即可，之后钩子随 git pull 同步。
# 等价的手动命令： git config core.hooksPath tools/hooks
set -eu

root=$(git rev-parse --show-toplevel) || exit 1
cd "$root"
[ -f tools/hooks/pre-commit ] && [ -f tools/hooks/pre-push ] || {
  echo "找不到 tools/hooks/*，请在仓库根目录执行本脚本。" >&2
  exit 1
}

git config core.hooksPath tools/hooks
chmod +x tools/hooks/pre-commit tools/hooks/pre-push tools/claim.sh 2>/dev/null || true

echo "hooksPath = $(git config --get core.hooksPath)"
echo "已启用：pre-commit（派生物黑名单 / 误提交提醒）"
echo "        pre-push（租约 + 非快进拦截，等价于禁 --force）"
echo "提示：core.hooksPath 是本机 git 配置，新 clone 的仓库要重新跑一次本脚本。"
