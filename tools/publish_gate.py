#!/usr/bin/env python3
"""发布前租约门禁（只读、不联网、不改文件）。

由 tools/deploy.cmd 在构建与重启之前调用，语义与 tools/hooks/pre-push 保持一致：

  - 无 CLAIM.json                        -> 放行
  - 租约已过期 / owner 或 expires 缺失   -> 视为无主，放行（打印 NOTE）
  - 未过期且 AI_SESSION == owner        -> 放行（持锁者本人发布）
  - 未过期且 AI_SESSION 缺失或不匹配    -> BLOCKED，退出码 1
  - CLAIM.json 不是合法 JSON            -> BLOCKED，绝不静默放行

服务器上的 python 通常不在 PATH，deploy.cmd 会用全路径调用本脚本；
若全路径失效会退回 `python`，两者都找不到时 errorlevel 非 0，同样 BLOCKED。
"""
import json
import os
import sys
import time
from pathlib import Path


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    claim = repo / "CLAIM.json"

    if not claim.exists():
        print("OK [publish-gate]: 当前无租约，允许发布。")
        return 0

    try:
        data = json.loads(claim.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"BLOCKED [publish-gate]: CLAIM.json 无法解析（{exc}），拒绝发布。")
        return 1

    owner = str(data.get("owner", ""))
    try:
        expires = int(data.get("expires", 0))
    except (TypeError, ValueError):
        expires = 0

    now = int(time.time())
    if not owner or expires <= now:
        print("NOTE [publish-gate]: 租约已过期或字段不完整，视为无主，允许发布。")
        return 0

    session = os.environ.get("AI_SESSION", "")
    if not session or session != owner:
        print(f"BLOCKED [publish-gate]: 仓库由 '{owner}' 持锁且尚未过期。")
        print("  等对方 tools/claim.sh release；确认失联则 tools/claim.sh takeover <名字> <任务>。")
        print(f"  若你就是该会话，先 set AI_SESSION={owner} 再执行发布。")
        return 1

    print(f"OK [publish-gate]: 本会话 '{session}' 持锁，允许发布。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
