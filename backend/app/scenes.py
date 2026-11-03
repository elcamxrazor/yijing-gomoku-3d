"""棋境预设：服务器端的一张静态表。

三个 ID 与前端 ``frontend/src/game/scenes.ts`` 里的 ``ScenePresetId`` 逐字对应。
特意不放枚举也不查库——棋境是「纯展示」的属性，加一张表、一套增删抽查接口
换来的只有复杂度，换来的是每加一个场景得改五处。

但校验必须做：客户端传上来的 ``scene`` 会被直接写进数据库、再广播给另一个人，
不认识的取值一定要在入口处挡掉。否则一个手写的 WebSocket 包就能让对手报错.
"""

from __future__ import annotations

import secrets

# 棋境 ID → 中文名（给房主没选、或者协议里要回显可读名时用）
SCENE_PRESETS: dict[str, str] = {
    "tea": "基础茶室",
    "courtyard": "日式庭院",
    "cyber": "赛博朋克",
    "living": "现代客厅",
    "studio": "摄影棚",
}

DEFAULT_SCENE_ID = "tea"

SCENE_IDS = tuple(SCENE_PRESETS)


def normalize_scene(value: object | None) -> str:
    """把任意输入收敛成一个合法棋境 ID。

    三种情况都要接住：

    * ``None``——老的自建 sqlite 库迁移前没有这一列，``getattr`` 兜出来是 None；
    * 未知字符串——客户端写错、或者有人手搓协议包；
    * 非字符串——JSON 里塞了个数字或数组。

    一律退回默认棋境。这里**不抛错**是刻意的：棋境错了最多是一局棋背景不同，
    没有理由为了它让整个快照 500，把人家下到一半的棋局废掉。
    """
    if isinstance(value, str) and value in SCENE_PRESETS:
        return value
    return DEFAULT_SCENE_ID


def random_scene() -> str:
    """随机挑一个棋境（建房时房主没选 / 约战自动开局时用）。"""
    return secrets.choice(SCENE_IDS)
