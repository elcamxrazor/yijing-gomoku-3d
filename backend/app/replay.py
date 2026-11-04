"""复盘：把已经下完的棋局重新摆一遍。

数据本来就在库里——`Game` 记着谁执黑、谁执白、棋境、胜负与获胜方式，
`GameMove` 记着每一手的位置与颜色。所以复盘不需要**新的存储**，
只需要一个「只读、且只给本人看」的出口。

两条边界写在这里，而不是散落到路由里：

* 只收录 **finished** 的棋局。没下完的棋局是「对局中」，属于对局服务，
  不该出现在复盘列表里——否则玩家会在复盘里点开一盘还在走的棋。
* 只有**参与者本人**能读。旁观者没留下关系，事后无权翻别人的棋谱。
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select

from .database import Database
from .game import AI_ID
from .models import Game, GameMove, User


def _iso(value: datetime | None) -> str | None:
    """把库里的时间序列化成**带时区**的 ISO 字符串。

    SQLite 的 `DateTime(timezone=True)` 只是「允许」带时区，实际存取**不保留**
    偏移量：写进去是 `2026-11-01T16:51+00:00`，读回来是 `2026-11-01T16:51` 这个
    naive 值。直接 `isoformat()` 就会产出一个没有偏移的字符串，而浏览器的
    `Date.parse` 会把这种字符串按**本地时间**解释——本机实测：UTC 16:51 的棋局
    在 UTC+8 的浏览器里显示成 16:51 而不是 00:51，整整差了一个时区。

    所以这里给 naive 值补上 UTC 标记。库里的值本来就都是 UTC 写的
    （`models.utcnow`），补标记是还原事实，不是猜。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


class ReplayError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class ReplayService:
    """已结束对局的只读视图。"""

    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    @staticmethod
    def _player(session, player_id: str | None) -> dict | None:
        if player_id is None:
            return None
        if player_id == AI_ID:
            return {"id": AI_ID, "name": "Rapfi"}
        user = session.get(User, int(player_id))
        # 游客账号会被定期清理；棋谱还要能翻，所以名字缺了就退回一个占位名。
        return {"id": str(player_id), "name": user.name if user else "已离开用户"}

    @staticmethod
    def _your_color(game: Game, user_id: int) -> int | None:
        player = str(user_id)
        if game.black_player_id == player:
            return 1
        if game.white_player_id == player:
            return 2
        return None

    def _summary(self, session, game: Game, user_id: int) -> dict:
        moves = sorted(game.moves, key=lambda move: move.move_index)
        return {
            "id": game.id,
            "mode": game.mode,
            "scene": game.scene,
            # 规则要一起带出来：从棋谱「一键续弈」时必须沿用同一套规则，
            # 否则一盘连珠局接过去变成无禁手，整个局面的合法性都变了。
            "rule": getattr(game, "rule", None) or "freestyle",
            "status": game.status,
            "winner": game.winner,
            # 收藏状态：收藏的棋谱永久保留；没收藏的按 30 天滚动清理。
            "favorite": bool(game.keep_forever),
            "winReason": game.win_reason,
            "moveCount": len(moves),
            # 这局从第几手开始（> 0 表示它本身就是从残局接手的练习局）。
            "startPly": int(getattr(game, "start_ply", 0) or 0),
            "players": {
                "black": self._player(session, game.black_player_id),
                "white": self._player(session, game.white_player_id),
            },
            "yourColor": self._your_color(game, user_id),
            "createdAt": _iso(game.created_at),
            # 没有单独的「结束时间」列：最后一手落下的时刻就是这一局的终点，
            # 一局 0 手的棋（开局即认输）则退回最后更新时间。
            "finishedAt": (
                _iso(moves[-1].created_at)
                if moves and moves[-1].created_at
                else _iso(game.updated_at)
            ),
        }

    # ------------------------------------------------------------------
    # 对外
    # ------------------------------------------------------------------

    def list_for_user(
        self,
        user_id: int,
        limit: int = 20,
        offset: int = 0,
        mode: str | None = None,
        favorite_only: bool = False,
    ) -> dict:
        """列出我参与过的、已经结束的棋局（新的在前）。

        `mode` 用来把「与好友」和「与 AI」分开：这两类棋的阅读目的完全不同——
        前者是复盘对手的思路，后者更接近自己练棋的记录，混在一条流水里只能靠
        逐行读小字来区分。
        """
        limit = max(1, min(limit, 50))
        offset = max(0, offset)
        # 只认这两个值；给别的（或没给）就当不过滤，不要因为参数脏了返回空列表。
        wanted = mode if mode in ("ai", "online") else None
        with self.db.session() as session:
            query = select(Game).where(
                Game.status == "finished",
                (Game.black_player_id == str(user_id))
                | (Game.white_player_id == str(user_id)),
            )
            if wanted:
                query = query.where(Game.mode == wanted)
            if favorite_only:
                query = query.where(Game.keep_forever.is_(True))
            rows = list(session.scalars(
                query.order_by(Game.updated_at.desc()).limit(limit).offset(offset)
            ).unique())
            return {
                "replays": [self._summary(session, game, user_id) for game in rows],
                "limit": limit,
                "offset": offset,
                "mode": wanted,
                "favorite": favorite_only,
            }

    def set_favorite(self, user_id: int, game_id: str, favorite: bool) -> bool:
        """收藏 / 取消收藏一局棋谱。幂等；非参与者视为不存在（与读取口径一致）。

        取消收藏只是把旗标放回 False，不需要额外的清理动作——30 天滚动清理每次
        扫描的都是「没收藏」的棋局，旗标一落，这局就自动回到清理范围里。
        """
        with self.db.session() as session:
            game = session.get(Game, game_id)
            if (
                not game
                or game.status != "finished"
                or str(user_id) not in {game.black_player_id, game.white_player_id}
            ):
                raise ReplayError("REPLAY_NOT_FOUND", "棋谱不存在")
            game.keep_forever = favorite
            return favorite

    def get(self, user_id: int, game_id: str) -> dict:
        """单局棋谱：摘要 + 完整着法序列。"""
        with self.db.session() as session:
            game = session.get(Game, game_id)
            if game is None:
                raise ReplayError("GAME_NOT_FOUND", "棋局不存在")
            if self._your_color(game, user_id) is None:
                # 刻意和「不存在」用同一个说法：报 403 等于告诉别人「这盘棋存在」。
                raise ReplayError("GAME_NOT_FOUND", "棋局不存在")
            _ = game.moves
            summary = self._summary(session, game, user_id)
            moves = sorted(game.moves, key=lambda move: move.move_index)
            summary["moves"] = [
                {
                    "index": move.move_index,
                    "row": move.row,
                    "col": move.col,
                    "color": move.color,
                }
                for move in moves
            ]
            return summary
