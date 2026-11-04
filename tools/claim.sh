#!/bin/sh
# 跨会话租约：靠 git push 的非快进失败做原子仲裁，不靠「大家看一眼文档」。
#
#   tools/claim.sh start    <owner> <task>   取锁（默认 45 分钟）
#   tools/claim.sh status                    看当前锁
#   tools/claim.sh release                   释放
#   tools/claim.sh takeover <owner> <task>  接管过期 / 失联的锁
#
# 用法提示：取锁后在本会话里 `export AI_SESSION=<owner>`，否则自己的推送也会被 pre-push 拦住。

set -u
TTL=${CLAIM_TTL:-2700}
repo=$(git rev-parse --show-toplevel) || exit 1
cd "$repo" || exit 1
claim="$repo/CLAIM.json"

say() { printf '%s\n' "$*"; }
die() { printf 'BLOCKED [claim]: %s\n' "$*" >&2; exit 1; }

field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$claim" | head -1; }
numfield() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$claim" | head -1; }
now=$(date +%s 2>/dev/null || echo 0)
started=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)

clean_task() { printf '%s' "$1" | tr -d '"\\\r\n' | cut -c1-120; }

push_claim() {
  # 要求暂存区干净，避免把别人的在制品一起提交
  [ -n "$(git diff --cached --name-only)" ] && die "暂存区已有内容，先提交或 git reset，再取锁。"
  git add CLAIM.json || die "git add 失败"
  if ! AI_SESSION="$1" git commit -q -m "$2"; then
    die "提交 CLAIM.json 失败（pre-commit 拦截？按提示处理）"
  fi
  if ! AI_SESSION="$1" git push -q origin HEAD:main; then
    say "远端已有别人的提交，锁没抢到。正在回滚本地这次尝试……"
    git reset -q --mixed HEAD~1
    if git ls-files --error-unmatch CLAIM.json >/dev/null 2>&1; then
      git checkout -q -- CLAIM.json
    else
      rm -f CLAIM.json
    fi
    die "取锁失败。执行 git pull --rebase origin main 后重新 start / takeover。"
  fi
}

case "${1:-}" in
  status)
    if [ -f "$claim" ]; then
      cat "$claim"
      exp=$(numfield expires)
      if [ -n "$exp" ] && [ "$now" -ge "$exp" ] 2>/dev/null; then
        say "(已过期)"
      fi
    else
      say "当前无锁。"
    fi
    ;;

  start|takeover)
    owner="${2:-}"
    task=$(clean_task "${3:-未说明}")
    [ -n "$owner" ] || die "用法：tools/claim.sh $1 <owner> <task>"
    [ "$1" = takeover ] || [ ! -f "$claim" ] || {
      exp=$(numfield expires)
      cur=$(field owner)
      if [ -n "$exp" ] && [ "$now" -lt "$exp" ] 2>/dev/null; then
        die "'$cur' 仍持锁。确认其失联请用 takeover。"
      fi
    }
    git fetch -q origin main 2>/dev/null || say "NOTE: fetch 失败，基线用本地 origin/main"
    base=$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD)
    expires=$((now + TTL))
    cat > "$claim" <<EOF
{
  "owner": "$owner",
  "task": "$task",
  "base": "$base",
  "started": "$started",
  "expires": $expires
}
EOF
    push_claim "$owner" "chore: claim $owner - $task"
    say "锁已生效：owner=$owner  base=$base  expires=$started + ${TTL}s"
    say "本会话请执行：export AI_SESSION=$owner"
    ;;

  release)
    [ -f "$claim" ] || die "当前无锁。"
    cur=$(field owner)
    if [ -n "${AI_SESSION:-}" ] && [ "$AI_SESSION" != "$cur" ]; then
      die "锁属于 '$cur'，AI_SESSION=$AI_SESSION 不匹配（可用 takeover 接管）。"
    fi
    git rm -q -f CLAIM.json || die "git rm 失败"
    if ! AI_SESSION="${AI_SESSION:-$cur}" git commit -q -m "chore: release claim by $cur"; then
      die "提交释放失败"
    fi
    AI_SESSION="${AI_SESSION:-$cur}" git push -q origin HEAD:main || die "推送释放失败，先 git pull --rebase"
    say "锁已释放。"
    ;;

  *)
    die "用法：tools/claim.sh {start <owner> <task>|status|release|takeover <owner> <task>}"
    ;;
esac
