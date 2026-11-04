"""在线大厅与约战。

大厅只是「谁在线、谁有空」的一层实时视图，约战是两名棋手之间一次有时限的
握手。两者都不落库：连接断了、进程重启了，握手就作废，也没有任何需要恢复的
历史。这让整个子系统可以完全活在内存里，不必给对局数据模型加任何字段。

四个原则：

1. **名单是算出来的，不是存起来的。** 在线来自 WebSocket 连接表，是否在局中
   来自客户端报告的 ``game.focus``。任何一处变化都重新算一遍，没有第二份需要
   同步的缓存。
2. **名单只推给正在看的人。** 对局中的玩家不需要被别人的进进出出打断；订阅
   状态挂在连接上，关掉大厅面板就不再收。
3. **约战有寿命。** 默认 30 秒没人回应就作废。否则一个走开的对手会让发起方
   永远停在「等待回应」，而真正的原因（人不在）被界面藏起来了。
4. **接受一次约战，其余握手全部作废。** 双方同时被多人约战时，只有落地的那
   一局有效，其余请求立刻回绝，谁都不会盯着一个已经不可能成立的弹窗等待。
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field

from sqlalchemy import select

from .game import GameError
from .models import Game, User


def _now() -> float:
    return time.monotonic()


@dataclass(eq=False)
class Challenge:
    """一次待确认的约战。id 只在内存里存在，不落库。"""

    id: str
    from_id: int
    to_id: int
    created_at: float
    ttl: float
    # 约战条件：由发起方在建约时定下，接受即沿用（不接受方另议——
    # 一个「接受/婉拒」的握手容不下一场讨价还价）。
    time_control: dict = field(default_factory=lambda: {"mode": "none", "perMoveMs": None})
    # 发起方选定的棋境。None 表示「没指定」，由 `create_challenge` 在开局时抽签；
    # 这里刻意不落成默认场景——那会把「随机」悄悄换成「茶室」。
    scene: str | None = None

    def expired(self, now: float) -> bool:
        return now - self.created_at >= self.ttl

    def remaining_ms(self, now: float) -> int:
        return max(0, int((self.ttl - (now - self.created_at)) * 1000))


class LobbyService:
    def __init__(self, games, settings):
        self.games = games
        self.settings = settings
        self.hub = None
        self._challenges: dict[str, Challenge] = {}
        self._focus: dict[int, str] = {}
        self._lock = asyncio.Lock()
        self._tickers: dict[asyncio.AbstractEventLoop, asyncio.Task] = {}

    @property
    def ttl(self) -> float:
        return float(self.settings.challenge_ttl_seconds)

    # ------------------------------------------------------------------
    # 在线名单
    # ------------------------------------------------------------------
    def _online_ids(self) -> list[int]:
        if not self.hub:
            return []
        return [user_id for user_id, connections in self.hub.connections.items() if connections]

    def _seats(self) -> dict[str, dict]:
        """谁正坐在棋盘前。

        判据是「客户端报告的当前棋局」，而不是「库里有没有一盘没下完的棋」。
        这两者会分叉：关掉浏览器标签、机器休眠、或者直接杀进程之后，那盘棋会
        一直停在 playing；只按库判断的话，这个人会永远以「对弈中」挂在名单里，
        既不能被约战，也没有任何入口回到那盘棋。

        客户端只在真的看着某个棋盘时才报告 game.focus，所以「有没有入口」与
        「是不是在局中」用的是同一个信号。人机对局同样适用——他确实在跟引擎下棋。
        """
        if not self._focus:
            return {}
        with self.games.db.session() as session:
            rows = list(session.scalars(
                select(Game).where(Game.id.in_(set(self._focus.values())))
            ).unique())
        live = {game.id: game for game in rows if game.status in {"waiting", "playing"}}
        seats: dict[str, dict] = {}
        for user_id, game_id in self._focus.items():
            game = live.get(game_id)
            if game is not None:
                seats[str(user_id)] = {"status": game.status, "gameId": game.id}
        return seats

    async def set_focus(self, user_id: int, game_id: str | None) -> None:
        """记录（或清除）某人此刻正在看哪盘棋。"""
        if not game_id:
            self._focus.pop(user_id, None)
        else:
            with self.games.db.session() as session:
                game = session.get(Game, game_id)
                participant = game is not None and str(user_id) in (
                    game.black_player_id, game.white_player_id,
                )
                live = participant and game.status in {"waiting", "playing"}
            if live:
                self._focus[user_id] = game_id
            else:
                self._focus.pop(user_id, None)
        await self.broadcast()

    def players(self) -> list[dict]:
        online = self._online_ids()
        if not online:
            return []
        seats = self._seats()
        spectate = getattr(self.games, "spectate", None)
        with self.games.db.session() as session:
            users = list(session.scalars(select(User).where(User.id.in_(online))))
        rows = []
        for user in users:
            seat = seats.get(str(user.id), {})
            if seat:
                status, game_id = seat.get("status", "idle"), seat.get("gameId")
            else:
                # 不在座位上、但正在看别人的棋：单独标成「观战中」，否则他看起来
                # 像「可约战」，约战过去对面的弹窗也就白弹了。
                watching = spectate.watching(user.id) if spectate else None
                status, game_id = ("watching", watching) if watching else ("idle", None)
            rows.append({
                "id": str(user.id),
                "name": user.name,
                "guest": bool(user.guest),
                "status": status,
                "gameId": game_id,
            })
        # 有空的人排在前面：大厅的第一用途是找一个现在就能坐下的人。
        rows.sort(key=lambda row: (row["status"] != "idle", row["name"].casefold()))
        return rows

    def payload(self) -> dict:
        players = self.players()
        return {
            "players": players,
            "counts": {
                "online": len(players),
                "idle": sum(1 for player in players if player["status"] == "idle"),
            },
        }

    async def push(self, connection) -> None:
        """给单个连接发一份名单，用于刚订阅大厅时。"""
        try:
            await connection.send({"type": "lobby.players", "payload": self.payload()})
        except RuntimeError:
            pass

    async def broadcast(self) -> None:
        """把最新的名单推给正在看大厅的人。

        只看订阅者：这是「大厅」这个概念该有的边界，也是不为对局玩家增加
        无关推送的原因。同一条 JSON 复用给所有订阅者。
        """
        if not self.hub:
            return
        message: dict | None = None
        for connections in list(self.hub.connections.values()):
            for connection in list(connections):
                if not connection.watching_lobby:
                    continue
                if message is None:
                    message = {"type": "lobby.players", "payload": self.payload()}
                try:
                    await connection.send(message)
                except RuntimeError:
                    # 关闭中的连接由 websocket 循环负责摘除，这里只跳过。
                    pass

    async def game_changed(self, game_id: str) -> None:
        """对局状态变化后刷新大厅。

        人机对局也刷新：他刚坐下和刚结束时，大厅里那行状态要跟着变。
        """
        with self.games.db.session() as session:
            mode = session.scalar(select(Game.mode).where(Game.id == game_id))
        if mode in {"online", "ai"}:
            await self.broadcast()

    async def _send(self, user_id: int, message: dict) -> None:
        if not self.hub:
            return
        for connection in list(self.hub.connections.get(user_id, ())):
            try:
                await connection.send(message)
            except RuntimeError:
                pass

    # ------------------------------------------------------------------
    # 约战
    # ------------------------------------------------------------------
    def _purge(self, now: float) -> list[Challenge]:
        expired = [item for item in self._challenges.values() if item.expired(now)]
        for item in expired:
            self._challenges.pop(item.id, None)
        return expired

    def _outgoing(self, user_id: int) -> Challenge | None:
        return next((item for item in self._challenges.values() if item.from_id == user_id), None)

    def _incoming(self, user_id: int) -> Challenge | None:
        return next((item for item in self._challenges.values() if item.to_id == user_id), None)

    def _involving(self, user_id: int) -> list[Challenge]:
        return [item for item in self._challenges.values() if user_id in (item.from_id, item.to_id)]

    async def _announce_expired(self, expired: list[Challenge]) -> None:
        for item in expired:
            for user_id in (item.from_id, item.to_id):
                await self._send(user_id, {
                    "type": "challenge.result",
                    "payload": {"challengeId": item.id, "status": "expired"},
                })

    async def create(
        self,
        user,
        target_id: int,
        time_control: dict | None = None,
        scene: str | None = None,
    ) -> dict:
        if target_id == user.id:
            raise GameError("CHALLENGE_SELF", "不能约战自己")
        # 先校验再落任何状态：一个非法的档位不该在别处留下半条约战。
        time_mode, per_move_ms = self.games.parse_time_control(time_control)
        normalized_time = {"mode": time_mode, "perMoveMs": per_move_ms}
        with self.games.db.session() as session:
            target = session.get(User, target_id)
            target_name = target.name if target else None
            target_guest = bool(target.guest) if target else False
        if not target_name:
            raise GameError("PLAYER_NOT_FOUND", "这位棋友已经不在了")
        if not self.hub or not self.hub.is_online(target_id):
            raise GameError("PLAYER_OFFLINE", f"{target_name} 已离开大厅")

        async with self._lock:
            now = _now()
            await self._announce_expired(self._purge(now))
            seats = self._seats()
            mine = seats.get(str(user.id))
            if mine and mine["status"] == "playing":
                raise GameError("ALREADY_PLAYING", "你正在对弈中，先结束当前棋局吧")
            if mine:
                raise GameError("ALREADY_PLAYING", "你在房间里等人，先取消等待再约战吧")
            theirs = seats.get(str(target_id))
            if theirs and theirs["status"] == "playing":
                raise GameError("PLAYER_BUSY", f"{target_name} 正在对弈中")
            if theirs:
                raise GameError("PLAYER_BUSY", f"{target_name} 正在房间里等人")
            existing = self._outgoing(user.id)
            if existing is not None:
                if existing.to_id == target_id:
                    # 同一目标的重复请求按幂等处理：网络抖一下不该变成两次约战。
                    return self._sent(existing, target_name, target_guest, now)
                raise GameError("CHALLENGE_PENDING", "已有一个约战在等待回应，先等一等")
            if self._incoming(user.id) is not None:
                raise GameError("CHALLENGE_INCOMING", "有人正在约战你，先回应那条邀请吧")
            challenge = Challenge(
                id=secrets.token_hex(4),
                from_id=user.id,
                to_id=target_id,
                created_at=now,
                ttl=self.ttl,
                time_control=normalized_time,
                scene=scene,
            )
            self._challenges[challenge.id] = challenge

        await self._send(target_id, {
            "type": "challenge.incoming",
            "payload": {
                "challengeId": challenge.id,
                "from": {"id": str(user.id), "name": user.name, "guest": bool(user.guest)},
                "expiresInMs": challenge.remaining_ms(_now()),
                # 接受即沿用：被约战方有权先知道这局要不要读秒、在哪片棋境里下。
                "timeControl": challenge.time_control,
                "scene": challenge.scene,
            },
        })
        return self._sent(challenge, target_name, target_guest, now)

    @staticmethod
    def _sent(challenge: Challenge, name: str, guest: bool, now: float) -> dict:
        return {
            "challengeId": challenge.id,
            "target": {"id": str(challenge.to_id), "name": name, "guest": guest},
            "expiresInMs": challenge.remaining_ms(now),
        }

    async def respond(self, user, challenge_id: str, accept: bool) -> dict:
        stale: list[Challenge] = []
        accepted_game: str | None = None
        failure: tuple[str, str, str] | None = None
        opponent_id = 0
        async with self._lock:
            now = _now()
            challenge = self._challenges.get(challenge_id)
            if challenge is None or challenge.to_id != user.id:
                raise GameError("CHALLENGE_NOT_FOUND", "这场约战已经失效")
            self._challenges.pop(challenge.id, None)
            if challenge.expired(now):
                raise GameError("CHALLENGE_EXPIRED", "约战已超时，重新发起一次吧")
            opponent_id = challenge.from_id
            await self._announce_expired(self._purge(now))
            if accept:
                if not self.hub or not self.hub.is_online(opponent_id):
                    failure = ("PLAYER_OFFLINE", "对方已经离开大厅", "对方已经离开大厅")
                else:
                    seats = self._seats()
                    if seats.get(str(user.id)):
                        failure = (
                            "ALREADY_PLAYING",
                            "你正在对局中，无法再开一局",
                            "对方正在对局中，约战未能成立",
                        )
                    elif seats.get(str(opponent_id)):
                        failure = (
                            "PLAYER_BUSY",
                            "对方已进入其他对局",
                            "你已进入其他对局，约战未能成立",
                        )
                if failure is None:
                    # 一局落地，双方手上其它待回应的握手就地作废。
                    stale = self._involving(user.id) + self._involving(opponent_id)
                    for item in stale:
                        self._challenges.pop(item.id, None)
                    accepted_game = await self.games.create_challenge(
                        opponent_id,
                        user.id,
                        scene=challenge.scene,
                        time_control=challenge.time_control,
                    )

        if failure is not None:
            code, message, own_reason = failure
            # 发起方要立刻知道这局没成，否则他会一直盯着「等待回应」直到超时。
            await self._send(opponent_id, {
                "type": "challenge.result",
                "payload": {
                    "challengeId": challenge_id, "status": "cancelled",
                    "byMe": False, "reason": own_reason,
                },
            })
            raise GameError(code, message)

        for item in {item.id: item for item in stale}.values():
            await self._notify_cancelled(item, "对局已开始")

        if not accept:
            result = {
                "challengeId": challenge_id, "status": "declined",
                "byName": user.name, "byMe": True,
            }
            await self._send(opponent_id, {
                "type": "challenge.result",
                "payload": {**result, "byMe": False},
            })
            await self.broadcast()
            return result

        result = {"challengeId": challenge_id, "status": "accepted", "gameId": accepted_game}
        # 先回执、再推快照：客户端需要先知道「约战成立」，才会认领随后到达的棋局。
        await self._send(opponent_id, {"type": "challenge.result", "payload": result})
        await self.games.broadcast(accepted_game)
        await self.broadcast()
        return result

    async def cancel(self, user, challenge_id: str) -> dict:
        async with self._lock:
            challenge = self._challenges.get(challenge_id)
            if challenge is None or challenge.from_id != user.id:
                raise GameError("CHALLENGE_NOT_FOUND", "这场约战已经失效")
            self._challenges.pop(challenge.id, None)
        result = {"challengeId": challenge_id, "status": "cancelled", "byMe": True}
        await self._send(challenge.to_id, {
            "type": "challenge.result",
            "payload": {**result, "byMe": False, "reason": "对方撤回了约战"},
        })
        return result

    async def _notify_cancelled(self, challenge: Challenge, reason: str) -> None:
        for user_id in (challenge.from_id, challenge.to_id):
            await self._send(user_id, {
                "type": "challenge.result",
                "payload": {
                    "challengeId": challenge.id, "status": "cancelled",
                    "byMe": False, "reason": reason,
                },
            })

    async def drop_user(self, user_id: int) -> None:
        """连接彻底断开时收回他发出的、收到的所有握手，以及他的座位。"""
        self._focus.pop(user_id, None)
        async with self._lock:
            dropped = self._involving(user_id)
            for item in dropped:
                self._challenges.pop(item.id, None)
        for item in dropped:
            other = item.to_id if item.from_id == user_id else item.from_id
            await self._send(other, {
                "type": "challenge.result",
                "payload": {
                    "challengeId": item.id,
                    "status": "cancelled",
                    "byMe": False,
                    "reason": "对方已离开大厅" if item.from_id == user_id else "你的约战邀请已失效",
                },
            })

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    def start(self) -> None:
        # 每个事件循环一个 ticker：测试会在同一个 app 上开多个 lifespan。
        loop = asyncio.get_running_loop()
        existing = self._tickers.get(loop)
        if existing is None or existing.done():
            self._tickers[loop] = asyncio.create_task(self._tick())

    async def _tick(self) -> None:
        try:
            while True:
                await asyncio.sleep(0.5)
                async with self._lock:
                    expired = self._purge(_now())
                try:
                    await self._announce_expired(expired)
                except Exception:
                    # 一次推送失败不该让整个 ticker 停摆。
                    pass
        except asyncio.CancelledError:
            return

    async def shutdown(self) -> None:
        task = self._tickers.pop(asyncio.get_running_loop(), None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._challenges.clear()
