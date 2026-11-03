import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field

from fastapi import WebSocket

from .models import Game


@dataclass(eq=False)
class Connection:
    websocket: WebSocket
    user_id: int
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # 只有打开了大厅面板的连接才收名单推送。对局中的玩家不需要每秒被
    # 别人的进进出出打断，这也是「大厅」这个概念该有的边界。
    watching_lobby: bool = False

    async def send(self, message: dict) -> None:
        async with self.send_lock:
            await self.websocket.send_json(message)


class ConnectionHub:
    def __init__(self, game_service):
        self.games = game_service
        self.spectate = None
        self.connections: dict[int, set[Connection]] = {}
        self._responses: OrderedDict[tuple[int, str], dict] = OrderedDict()
        self._request_locks: dict[tuple[int, str], asyncio.Lock] = {}

    async def register(self, websocket: WebSocket, user_id: int) -> Connection:
        connection = Connection(websocket, user_id)
        self.connections.setdefault(user_id, set()).add(connection)
        return connection

    def is_online(self, user_id: int) -> bool:
        return bool(self.connections.get(user_id))

    def unregister(self, connection: Connection) -> None:
        connections = self.connections.get(connection.user_id)
        if connections:
            connections.discard(connection)
            if not connections:
                self.connections.pop(connection.user_id, None)
        # Disconnects never resign; persisted participants can resume after a refresh.

    def request_lock(self, user_id: int, request_id: str) -> asyncio.Lock:
        key = (user_id, request_id)
        return self._request_locks.setdefault(key, asyncio.Lock())

    def cached_response(self, user_id: int, request_id: str) -> dict | None:
        key = (user_id, request_id)
        response = self._responses.get(key)
        if response:
            self._responses.move_to_end(key)
        return response

    def cache_response(self, user_id: int, request_id: str, response: dict) -> None:
        key = (user_id, request_id)
        self._responses[key] = response
        self._responses.move_to_end(key)
        while len(self._responses) > 2048:
            old_key, _ = self._responses.popitem(last=False)
            self._request_locks.pop(old_key, None)

    @staticmethod
    def _participant_ids(game: Game) -> list[int]:
        result = []
        for value in (game.black_player_id, game.white_player_id):
            if value and value.isdigit():
                result.append(int(value))
        return result

    def _game_users(self, game_id: str) -> list[int]:
        with self.games.db.session() as session:
            game = session.get(Game, game_id)
            return self._participant_ids(game) if game else []

    def spectator_ids(self, game_id: str) -> list[int]:
        return list(self.spectate.watchers(game_id)) if self.spectate else []

    async def send_to_user(self, user_id: int, message: dict) -> None:
        """给某个人的全部连接发同一条消息（多标签页会各收一份）。"""
        for connection in list(self.connections.get(user_id, ())):
            try:
                await connection.send(message)
            except RuntimeError:
                self.unregister(connection)

    async def send_to_spectators(self, game_id: str, message: dict) -> None:
        for user_id in self.spectator_ids(game_id):
            await self.send_to_user(user_id, message)

    async def send_to_game(self, game_id: str, message: dict) -> None:
        """把一条消息发给棋手与观战者（用于开局揭晓这类需要双方同看一次的瞬时事件）。"""
        for user_id in self._game_users(game_id):
            await self.send_to_user(user_id, message)
        await self.send_to_spectators(game_id, message)

    async def broadcast_game(self, game_id: str) -> None:
        """把最新快照发给棋手与观战者。

        两者的差别只在快照本身（观战者的 ``yourColor`` 为 null、不能悔棋），
        棋盘、手数与胜负完全一样——否则「看到两个不同的棋局」会是最难查的 bug。
        """
        participants = self._game_users(game_id)
        sent: set[int] = set()
        for user_id in participants:
            if user_id in sent:
                continue
            sent.add(user_id)
            connections = list(self.connections.get(user_id, ()))
            if not connections:
                continue
            snapshot = self.games.snapshot(game_id, user_id)
            for connection in connections:
                try:
                    await connection.send({"type": "game.snapshot", "payload": snapshot})
                except RuntimeError:
                    self.unregister(connection)
        for user_id in self.spectator_ids(game_id):
            if user_id in sent:
                continue
            sent.add(user_id)
            connections = list(self.connections.get(user_id, ()))
            if not connections:
                continue
            try:
                snapshot = self.games.spectator_snapshot(game_id, user_id)
            except Exception:
                # 已经不在资格内（例如自己刚坐下成了棋手），跳过这一轮。
                continue
            for connection in connections:
                try:
                    await connection.send({"type": "game.snapshot", "payload": snapshot})
                except RuntimeError:
                    self.unregister(connection)

    async def send_game_error(self, game_id: str, code: str, message: str) -> None:
        for user_id in self._game_users(game_id):
            for connection in list(self.connections.get(user_id, ())):
                await connection.send({"type": "error", "error": {"code": code, "message": message}})

    async def send_undo_requested(self, game_id: str, from_user_id: int) -> None:
        for user_id in self._game_users(game_id):
            if user_id == from_user_id:
                continue
            snapshot = self.games.snapshot(game_id, user_id)
            request = snapshot.get("undoRequest")
            if request:
                for connection in list(self.connections.get(user_id, ())):
                    await connection.send({
                        "type": "game.undo_requested",
                        "payload": {"gameId": game_id, **request},
                    })

    async def send_restart_requested(self, game_id: str, from_user_id: int) -> None:
        for user_id in self._game_users(game_id):
            if user_id == from_user_id:
                continue
            snapshot = self.games.snapshot(game_id, user_id)
            request = snapshot.get("restartRequest")
            if request:
                for connection in list(self.connections.get(user_id, ())):
                    await connection.send({
                        "type": "game.restart_requested",
                        "payload": {"gameId": game_id, **request},
                    })
