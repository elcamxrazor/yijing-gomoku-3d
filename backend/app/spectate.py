"""观战：第三个人进别人的棋局看棋。

观战不是「第三种玩家」，它没有任何写入能力，也不占座位：

- **不写库。** 谁在看哪盘棋只活在内存里，断线即消失。没有需要恢复的历史，
  也就不该给对局表加字段。
- **不进大厅座位。** 观战者在大厅里单独标为「观战中」——他并没有坐在棋盘前，
  只是站在旁边看；大厅名单里可以一眼分清。
- **不提权。** 观战快照里 ``yourColor`` 恒为 ``null``，服务端会拒绝一切落子、
  悔棋、重开、认输。权限判据始终是 ``_participants``，观战身份不参与其中。

好友联机与人机对局都可以旁观：AI 执子的那局往往正是最值得看的棋，
没有理由把第三个人挡在门外。

棋局结束时观战者留在原地看结果，而不是被拽回首页：一盘棋看完了，人还在。
想做别的事，点「离开观战」就行。
"""

from __future__ import annotations

from .game import GameError
from .models import Game


class SpectatorService:
    def __init__(self, games):
        self.games = games
        self.hub = None
        # 双向索引：一个人同时只看一盘棋，一盘棋可以有很多人看。
        self._by_user: dict[int, str] = {}
        self._by_game: dict[str, set[int]] = {}

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------
    def watchers(self, game_id: str) -> set[int]:
        return set(self._by_game.get(game_id, ()))

    def count(self, game_id: str) -> int:
        return len(self._by_game.get(game_id, ()))

    def watching(self, user_id: int) -> str | None:
        return self._by_user.get(user_id)

    # ------------------------------------------------------------------
    # 进出
    # ------------------------------------------------------------------
    async def join(self, user, game_id: str) -> dict:
        with self.games.db.session() as session:
            game = session.get(Game, game_id)
            if game is None or game.mode not in ("online", "ai"):
                # 人机对局同样允许旁观：AI 执子的棋局往往正是最值得看的棋。
                raise GameError("GAME_NOT_FOUND", "这盘棋不存在或不能观战")
            if str(user.id) in (game.black_player_id, game.white_player_id):
                raise GameError("ALREADY_PLAYER", "你就在这盘棋里")
            if game.status != "playing":
                # waiting 的房间还没开始，finished 的已经散场，都不值得开一扇窗。
                raise GameError("GAME_NOT_LIVE", "这盘棋还没有开始或已经结束")

        previous = self._by_user.get(user.id)
        if previous and previous != game_id:
            self._detach(user.id, previous)
        self._by_user[user.id] = game_id
        self._by_game.setdefault(game_id, set()).add(user.id)

        # 让局内人知道「有人来看棋」，顺便把新的观战人数推给他们。
        # 新观战者随后会收到 join 的回执快照，这里少发一份也无所谓。
        if self.hub:
            await self.hub.broadcast_game(game_id)
        return self.games.spectator_snapshot(game_id, user.id)

    async def leave(self, user) -> None:
        game_id = self._by_user.get(user.id)
        if not game_id:
            return
        self._detach(user.id, game_id)
        if self.hub:
            await self.hub.broadcast_game(game_id)

    async def drop_user(self, user_id: int) -> None:
        """连接彻底断开：立刻收回旁观席位，别让别人的人数一直虚高。"""
        game_id = self._by_user.get(user_id)
        if not game_id:
            return
        self._detach(user_id, game_id)
        if self.hub:
            await self.hub.broadcast_game(game_id)

    def _detach(self, user_id: int, game_id: str) -> None:
        self._by_user.pop(user_id, None)
        watchers = self._by_game.get(game_id)
        if not watchers:
            return
        watchers.discard(user_id)
        if not watchers:
            self._by_game.pop(game_id, None)
